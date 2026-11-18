import { HostIdentities } from "./host-identity.mjs";
import { tagsFor, resourceId } from "./provider.mjs";
import { randomUUID } from "node:crypto";
import { PluginError } from "./result.mjs";
const fail = (code, message) => {
  throw new PluginError(code, message);
};
export class Lifecycle {
  constructor(store, api, remote, { ensureController } = {}) {
    this.ensureController = ensureController;
    this.store = store;
    this.api = api;
    this.remote = remote;
    this.hostIdentities = new HostIdentities(store);
  }
  async configureExpiry(id, minutes, confirmation) {
    checkMinutes(minutes);
    if (confirmation !== `AUTO-HIBERNATE ${id}`)
      fail(
        "approval_required",
        "Approve recurring automatic snapshot-and-release for this exact logical worker.",
      );
    await this.ensureController?.();
    return this.store.withLock(id, async () => {
      const r = this.store.get(id);
      if (r.pending || r.hibernate)
        fail(
          "operation_pending",
          "Finish the retained operation before changing expiry.",
        );
      return this.store.update(id, (v) => ({
        ...v,
        expiry: {
          mode: "idle",
          minutes,
          approvedAt: new Date().toISOString(),
          session: v.vm ? expirySession(v.vm.serverId) : null,
        },
      }));
    });
  }
  async disableExpiry(id, confirmation) {
    if (confirmation !== `DISABLE AUTO-HIBERNATE ${id}`)
      fail(
        "approval_required",
        "Confirm disabling the deadline for this exact worker. Allocated compute will remain billed.",
      );
    return this.store.withLock(id, async () => {
      const r = this.store.get(id);
      if (r.pending || (r.hibernate && r.hibernate.stage !== "shutdown"))
        fail(
          "operation_pending",
          "Finish the retained operation before disabling expiry.",
        );
      return this.store.update(id, (v) => ({
        ...v,
        expiry: null,
        hibernate: null,
        powerCheckpoint: v.hibernate?.checkpoint ?? v.powerCheckpoint,
      }));
    });
  }
  async extendExpiry(id, minutes) {
    checkMinutes(minutes);
    await this.ensureController?.();
    return this.store.withLock(id, async () => {
      const r = this.store.get(id);
      if (
        !r.expiry?.approvedAt ||
        !r.vm ||
        !r.expiry.session ||
        r.hibernate ||
        r.pending
      )
        fail(
          "expiry_not_extendable",
          "Enable automatic hibernation for an allocated worker without a pending operation first.",
        );
      return this.store.update(id, (v) => ({
        ...v,
        expiry: {
          ...v.expiry,
          session: {
            ...v.expiry.session,
            deferUntil: new Date(
              Math.max(
                Date.now(),
                Date.parse(v.expiry.session.expiresAt) || 0,
                Date.parse(v.expiry.session.deferUntil) || 0,
              ) +
                minutes * 60000,
            ).toISOString(),
            state: "scheduled",
            error: null,
          },
        },
      }));
    });
  }
  async startExpiryLocked(id, { renew = false } = {}) {
    let r = this.store.get(id);
    if (!r.expiry?.approvedAt) return r;
    checkMinutes(r.expiry.minutes);
    await this.ensureController?.();
    if (renew || !r.expiry.session || r.expiry.session.state === "released")
      r = await this.store.update(id, (v) => ({
        ...v,
        expiry: {
          ...v.expiry,
          session: expirySession(v.vm?.serverId ?? null),
        },
      }));
    return r;
  }
  async expire(id, sessionId, now = Date.now()) {
    return this.store.withLock(id, async () => {
      let r = this.store.get(id),
        session = r.expiry?.session;
      if (
        !r.expiry?.approvedAt ||
        !session ||
        session.id !== sessionId ||
        session.state === "released"
      )
        return r;
      checkMinutes(r.expiry.minutes);
      if (
        r.vm &&
        session.serverId !== r.vm.serverId &&
        !(
          session.serverId === null &&
          r.pending?.kind === "create" &&
          r.pending.attempted
        )
      )
        fail(
          "expiry_target_changed",
          "Expiry target differs from current VM; no mutation performed.",
        );
      if (r.pending?.kind === "create" && r.pending.attempted) {
        r = await this.createLocked(id);
        session = r.expiry.session;
      }
      if (r.pending?.kind === "poweron") {
        const server = await this.owned(r);
        if (!r.pending.attempted && server?.powerState !== "running")
          fail(
            "operation_pending",
            "Unsubmitted power-on requires explicit recovery; the controller will not start compute.",
          );
        r = await this.powerLocked(id, "poweron");
        session = r.expiry.session;
      }
      if (!r.vm) return r;
      if (session.serverId !== r.vm.serverId)
        fail(
          "expiry_target_changed",
          "Expiry target differs from current VM; no mutation performed.",
        );
      if (!(r.hibernate && session.releaseAuthorized)) {
        const activity = r.hibernate
          ? { state: "idle", token: "checkpoint:" + r.hibernate.checkpoint?.at }
          : ((await this.remote.activity?.(r)) ?? { state: "unknown" });
        session = idleObservation(session, activity, r.expiry.minutes, now);
        r = await this.store.update(id, (v) => ({
          ...v,
          expiry: { ...v.expiry, session },
        }));
        if (!session.expiresAt || Date.parse(session.expiresAt) > now) return r;
        if (!r.hibernate) {
          const latest = (await this.remote.activity?.(r)) ?? {
            state: "unknown",
          };
          if (latest.state !== "idle" || latest.token !== activity.token) {
            session = idleObservation(
              { ...session, idleSince: null },
              latest,
              r.expiry.minutes,
              now,
            );
            return this.store.update(id, (v) => ({
              ...v,
              expiry: { ...v.expiry, session },
            }));
          }
        }
      }
      await this.store.update(id, (v) => ({
        ...v,
        expiry: {
          ...v.expiry,
          session: {
            ...v.expiry.session,
            releaseAuthorized: true,
            state: "expiring",
            error: null,
          },
        },
      }));
      try {
        const result = await this.hibernateLocked(id);
        return await this.releaseLocked(id, result.confirmation);
      } catch (error) {
        await this.store.update(id, (v) => ({
          ...v,
          expiry: {
            ...v.expiry,
            session: {
              ...v.expiry.session,
              state: "failed",
              error:
                error instanceof PluginError ? error.code : "expiry_failed",
              failedAt: new Date().toISOString(),
            },
          },
        }));
        throw error;
      }
    });
  }
  labels(r, operation) {
    return {
      "herdr-plugin": "vultr.sandbox",
      "herdr-worker": r.id,
      ...(operation ? { "herdr-operation": operation } : {}),
    };
  }
  description(r, operation) {
    return `herdr:vultr.sandbox:worker=${r.id}:operation=${operation}`;
  }
  async owned(r, { allowVolumes = false } = {}) {
    if (!r.vm) return null;
    const s = await this.api.getServer(r.vm.serverId);
    if (
      s &&
      (s.id !== r.vm.serverId ||
        !tagsFor(this.labels(r)).every((t) => s.tags?.includes(t)))
    )
      fail("ownership_mismatch", "Instance tags do not match this worker.");
    if (!allowVolumes && s?.volumes?.length)
      fail(
        "volumes_unsupported",
        "Attached block storage is unsupported; no lifecycle mutation performed.",
      );
    return s;
  }
  async status(id) {
    const r = this.store.get(id),
      s = await this.owned(r, { allowVolumes: true });
    return {
      workerId: id,
      phase: r.phase,
      serverId: r.vm?.serverId ?? null,
      providerStatus: s?.powerState ?? "absent",
      volumes: s?.volumes ?? [],
      lifecycleBlocked: s?.volumes?.length
        ? "attached blocks unsupported"
        : null,
      snapshotId: r.snapshot?.imageId ?? null,
      automaticHibernation: r.expiry ?? null,
      pending: r.pending
        ? {
            kind: r.pending.kind,
            operation: r.pending.operation,
            attempted: r.pending.attempted,
            acknowledged: r.pending.acknowledged ?? false,
            started: r.pending.started ?? null,
          }
        : null,
      billing: s
        ? "Instance remains billed while allocated, including when powered off. Snapshots are billed separately."
        : "Retained snapshots and any separately managed reserved IPs or block storage remain billed.",
    };
  }
  async receipt(id, kind, extra = {}) {
    return this.store.update(id, (r) => ({
      ...r,
      pending: { kind, operation: randomUUID(), attempted: false, ...extra },
    }));
  }
  async attempted(id) {
    return this.store.update(id, (r) => ({
      ...r,
      pending: {
        ...r.pending,
        attempted: true,
        started: new Date().toISOString(),
      },
    }));
  }
  async submit(id, method, url, body) {
    try {
      return await this.api.request(method, url, body);
    } catch (error) {
      if (
        error.code === "provider_rejected" &&
        Number.isInteger(error.httpStatus) &&
        error.httpStatus >= 400 &&
        error.httpStatus < 500 &&
        ![408, 409].includes(error.httpStatus)
      ) {
        await this.store.update(id, (r) => ({
          ...r,
          lastRejectedOperation: {
            kind: r.pending.kind,
            operation: r.pending.operation,
            serverId: r.vm?.serverId ?? null,
            httpStatus: error.httpStatus,
            at: new Date().toISOString(),
          },
          pending: null,
        }));
      }
      throw error;
    }
  }
  async create(id, publicKey) {
    return this.store.withLock(id, () => this.createLocked(id, publicKey));
  }
  async createLocked(id, publicKey) {
    let r = this.store.get(id);
    if (r.vm) {
      if (!(await this.owned(r)))
        fail(
          "server_missing",
          "Mapped instance is absent; no replacement was allocated.",
        );
      if (r.pending?.kind !== "create") return r;
    }
    if (r.pending && r.pending.kind !== "create")
      fail("operation_pending", "Finish the retained operation first.");
    r = await this.startExpiryLocked(id, { renew: !r.pending });
    if (!r.pending) r = await this.receipt(id, "create");
    if (!r.vm) {
      const found = await this.api.find(
        "instances",
        this.labels(r, r.pending.operation),
      );
      if (found.length > 1)
        fail(
          "ambiguous_operation",
          "Multiple instances match this exact operation; inspect account state.",
        );
      let server = found[0];
      if (!server) {
        if (r.pending.attempted)
          fail(
            "outcome_unknown",
            "Create was submitted but no matching tagged instance is visible. No duplicate will be submitted.",
          );
        if (
          !/^ssh-(ed25519|rsa) [A-Za-z0-9+/]+=*(?: [^\r\n]*)?$/.test(
            publicKey ?? "",
          )
        )
          fail("ssh_key_required", "An intended public SSH key is required.");
        if (r.snapshot)
          this.usable(await this.api.getImage(r.snapshot.imageId), r);
        if (!r.pending.hostIdentity) {
          const hostIdentity = this.hostIdentities.prepare(
            id,
            r.pending.operation,
          );
          r = await this.store.update(id, (v) => ({
            ...v,
            pending: { ...v.pending, hostIdentity },
          }));
        }
        r = await this.attempted(id);
        const result = await this.submit(id, "POST", "/instances", {
          label: `herdr-${id.slice(0, 8)}-${r.pending.operation.slice(0, 8)}`,
          region: r.config.region,
          plan: r.config.plan,
          ...(r.snapshot
            ? { snapshot_id: resourceId(r.snapshot.imageId) }
            : { os_id: r.config.osId }),
          tags: tagsFor(this.labels(r, r.pending.operation)),
          backups: "disabled",
          enable_ipv6: true,
          activation_email: false,
          user_data: Buffer.from(
            this.hostIdentities.cloudConfig(r.pending.hostIdentity, publicKey),
          ).toString("base64"),
        });
        server = result?.instance;
      }
      resourceId(server?.id);
      if (!r.pending.hostIdentity)
        fail(
          "host_identity_missing",
          "Retained create lacks its provisioned host identity. No SSH connection made.",
        );
      r = await this.store.update(id, (v) => ({
        ...v,
        vm: {
          serverId: server.id,
          plan: server.plan ?? v.config.plan,
          disk: server.disk ?? v.snapshot?.disk ?? null,
          hostKey: v.pending.hostIdentity.publicKey,
          hostKeySource: "provisioned",
          ip: server.main_ip ?? null,
          initialized: !!v.snapshot,
        },
        pending: { ...v.pending, acknowledged: true },
        phase: "creating",
      }));
    }
    if (r.expiry?.session && r.expiry.session.serverId === null)
      r = await this.store.update(id, (v) => ({
        ...v,
        expiry: {
          ...v.expiry,
          session: { ...v.expiry.session, serverId: v.vm.serverId },
        },
      }));
    await this.owned(r);
    const server = await this.api.waitStatus(r.vm.serverId, "running");
    if (
      !server ||
      server.id !== r.vm.serverId ||
      !tagsFor(this.labels(r, r.pending.operation)).every((t) =>
        server.tags?.includes(t),
      )
    )
      fail(
        "ownership_mismatch",
        "Ready instance does not match the retained create operation.",
      );
    return this.store.update(id, (v) => ({
      ...v,
      vm: { ...v.vm, ip: server.main_ip, disk: server.disk, plan: server.plan },
      pending: null,
      phase: v.snapshot ? "restore-verification" : "setup-required",
    }));
  }
  usable(image, r) {
    const expected =
      r.pending?.kind === "snapshot"
        ? this.description(r, r.pending.operation)
        : r.snapshot?.description;
    if (
      !image ||
      image.status !== "complete" ||
      !(image.size > 0) ||
      image.os_id !== r.config.osId ||
      !expected ||
      image.description !== expected
    )
      fail(
        "snapshot_unusable",
        "Snapshot is incomplete or does not match the recorded worker operation and Linux OS. Instance retained.",
      );
    // Vultr snapshots expose no architecture field. Keep the same frozen plan and disk.
    if (r.snapshot?.plan && r.snapshot.plan !== r.config.plan)
      fail(
        "snapshot_unusable",
        "Restore must keep the saved plan; cross-plan/architecture restore is unsupported.",
      );
  }
  async power(id, kind) {
    return this.store.withLock(id, () => this.powerLocked(id, kind));
  }
  async powerLocked(id, kind) {
    if (!["shutdown", "poweron"].includes(kind))
      fail("invalid_operation", "Unsupported power operation.");
    let r = this.store.get(id);
    let s = await this.owned(r);
    if (!s) fail("server_missing", "No allocated instance.");
    if (r.pending && r.pending.kind !== kind)
      fail("operation_pending", "Finish the retained operation first.");
    if (r.pending && r.pending.serverId !== r.vm.serverId)
      fail("stale_server", "Power receipt targets another instance.");
    if (kind === "poweron") {
      r = await this.startExpiryLocked(id, {
        renew: !r.pending,
      });
      if (r.hibernate)
        r = await this.store.update(id, (v) => ({ ...v, hibernate: null }));
    }
    const status = kind === "shutdown" ? "off" : "running";
    if (s.powerState === status)
      return this.store.update(id, (v) => ({ ...v, pending: null }));
    if (!r.pending) {
      if (kind === "shutdown" && r.hibernate?.stage !== "shutdown") {
        if (r.hibernate)
          r = await this.store.update(id, (v) => ({ ...v, hibernate: null }));
        await this.remote.quiesce(r);
        const checkpoint = await this.remote.checkpoint(r);
        if (r.expiry?.approvedAt) await this.remote.prepareSnapshot(r);
        r = await this.store.update(id, (v) => ({
          ...v,
          powerCheckpoint: checkpoint,
          ...(v.expiry?.approvedAt
            ? { hibernate: { checkpoint, stage: "shutdown" } }
            : {}),
        }));
      }
      r = await this.receipt(id, kind, {
        serverId: r.vm.serverId,
        ...(kind === "shutdown" ? { providerOperation: "halt" } : {}),
      });
    }
    if (r.pending.serverId !== r.vm.serverId)
      fail("stale_server", "Power receipt targets another instance.");
    if (r.pending.attempted) {
      // No provider action IDs exist. Only the observed target state can settle a receipt.
      if (!r.pending.acknowledged)
        fail(
          "outcome_unknown",
          "Power request outcome unknown; no command replayed. Observe until target state is confirmed.",
        );
    } else {
      if (kind === "shutdown" && r.pending.providerOperation !== "halt")
        fail(
          "outcome_unknown",
          "Historical guest shutdown receipt cannot authorize provider Stop. Observe the retained target; no request replayed.",
        );
      s = await this.owned(r);
      if (!s) fail("server_missing", "No allocated instance.");
      if (s.powerState === status)
        return this.store.update(id, (v) => ({ ...v, pending: null }));
      if (kind === "poweron" && s.powerState !== "off")
        fail(
          "status_pending",
          "Start is allowed only for a confirmed stopped instance; Vultr Start can restart a running instance.",
        );
      r = await this.attempted(id);
      await this.submit(
        id,
        "POST",
        `/instances/${resourceId(s.id)}/${kind === "shutdown" ? "halt" : "start"}`,
      );
      r = await this.store.update(id, (v) => ({
        ...v,
        pending: { ...v.pending, acknowledged: true },
      }));
    }
    await this.api.waitStatus(s.id, status);
    return this.store.update(id, (v) => ({ ...v, pending: null }));
  }
  async hibernate(id) {
    return this.store.withLock(id, () => this.hibernateLocked(id));
  }
  async hibernateLocked(id) {
    let r = this.store.get(id),
      s = await this.owned(r);
    if (!s && r.hibernate?.stage !== "release")
      fail("server_missing", "No allocated instance.");
    if (!r.hibernate) {
      if (r.pending)
        fail("operation_pending", "Finish the retained operation first.");
      if (s.powerState !== "running")
        fail(
          "checkpoint_required",
          "Resume and checkpoint the instance before hibernating.",
        );
      await this.remote.quiesce(r);
      const checkpoint = await this.remote.checkpoint(r);
      await this.remote.prepareSnapshot(r);
      r = await this.store.update(id, (v) => ({
        ...v,
        hibernate: { checkpoint, stage: "shutdown" },
        phase: "hibernating",
      }));
    }
    if (r.hibernate.stage === "shutdown") {
      await this.powerLocked(id, "shutdown");
      r = await this.store.update(id, (v) => ({
        ...v,
        hibernate: { ...v.hibernate, stage: "snapshot" },
      }));
    }
    if (r.hibernate.stage === "snapshot") {
      if (!r.pending)
        r = await this.receipt(id, "snapshot", { serverId: r.vm.serverId });
      if (r.pending.kind !== "snapshot")
        fail("operation_pending", "Another operation is pending.");
      if (!r.pending.imageId) {
        const description = this.description(r, r.pending.operation);
        const found = await this.api.find("snapshots", { description });
        if (found.length > 1)
          fail(
            "ambiguous_operation",
            "Multiple snapshots have the exact operation description.",
          );
        let image = found[0];
        if (!image) {
          if (r.pending.attempted)
            fail(
              "outcome_unknown",
              "Snapshot outcome unknown. No duplicate request; instance and previous snapshot retained.",
            );
          if ((await this.owned(r))?.powerState !== "off")
            fail(
              "server_not_off",
              "Snapshot requires freshly confirmed provider OFF.",
            );
          r = await this.attempted(id);
          image = (
            await this.submit(id, "POST", "/snapshots", {
              instance_id: resourceId(r.vm.serverId),
              description,
            })
          )?.snapshot;
        }
        resourceId(image?.id);
        r = await this.store.update(id, (v) => ({
          ...v,
          pending: { ...v.pending, imageId: image.id, acknowledged: true },
        }));
      }
      const image = await this.api.waitSnapshot(r.pending.imageId);
      this.usable(image, r);
      r = await this.store.update(id, (v) => ({
        ...v,
        snapshot: {
          imageId: image.id,
          description: image.description,
          osId: image.os_id,
          plan: v.vm.plan,
          disk: v.vm.disk,
          checkpoint: v.hibernate.checkpoint,
          operation: v.pending.operation,
          previousImageId: v.snapshot?.imageId ?? null,
        },
        pending: null,
        hibernate: { ...v.hibernate, stage: "release" },
        phase: "release-approval",
      }));
    }
    return {
      status: "release_approval_required",
      workerId: id,
      serverId: r.vm.serverId,
      snapshotId: r.snapshot.imageId,
      confirmation: `DELETE ${r.vm.serverId} SNAPSHOT ${r.snapshot.imageId}`,
    };
  }
  async release(id, confirmation) {
    return this.store.withLock(id, () => this.releaseLocked(id, confirmation));
  }
  async releaseLocked(id, confirmation) {
    const r = this.store.get(id);
    if (!r.vm && r.phase === "hibernated") return r;
    if (
      r.hibernate?.stage !== "release" ||
      confirmation !==
        `DELETE ${r.vm?.serverId} SNAPSHOT ${r.snapshot?.imageId}`
    )
      fail(
        "approval_required",
        "Exact instance and verified snapshot approval is required.",
      );
    const cp = r.snapshot?.checkpoint;
    if (
      !cp ||
      cp.workerId !== id ||
      !/^[a-f0-9]{64}$/.test(cp.sourceDigest ?? "") ||
      !/^[a-f0-9]{64}$/.test(cp.currentSourceDigest ?? "") ||
      !Number.isFinite(Date.parse(cp.at)) ||
      JSON.stringify(cp) !== JSON.stringify(r.hibernate.checkpoint)
    )
      fail(
        "checkpoint_missing",
        "Verified snapshot must retain the exact durable worker checkpoint.",
      );
    this.usable(await this.api.getImage(r.snapshot.imageId), r);
    const s = await this.owned(r);
    if (s && s.powerState !== "off")
      fail("server_not_off", "Instance must still be stopped before release.");
    return this.deleteLocked(id, confirmation, "hibernated");
  }
  async deleteServer(id, confirmation) {
    return this.store.withLock(id, async () => {
      const r = this.store.get(id);
      if (!r.vm) fail("server_missing", "No instance to delete.");
      if (confirmation !== `DELETE ${r.vm.serverId}`)
        fail(
          "approval_required",
          "Exact instance approval is required; disk data may be lost.",
        );
      if (r.pending && r.pending.kind !== "delete")
        fail("operation_pending", "Finish the retained operation first.");
      await this.owned(r);
      return this.deleteLocked(id, confirmation, "deleted");
    });
  }
  async deleteLocked(id, confirmation, phase) {
    let r = this.store.get(id);
    const serverId = r.vm.serverId;
    if (r.pending && r.pending.kind !== "delete")
      fail("operation_pending", "Another operation is pending.");
    if (!r.pending)
      r = await this.receipt(id, "delete", { serverId, confirmation });
    if (
      r.pending.confirmation !== confirmation ||
      r.pending.serverId !== serverId
    )
      fail("approval_required", "Pending deletion approval differs.");
    const s = await this.owned(r);
    if (s) {
      if (r.pending.attempted && !r.pending.acknowledged)
        fail(
          "outcome_unknown",
          "Delete outcome unknown and instance still exists. No duplicate DELETE sent.",
        );
      if (!r.pending.attempted) {
        r = await this.attempted(id);
        await this.submit(id, "DELETE", `/instances/${resourceId(serverId)}`);
        await this.store.update(id, (v) => ({
          ...v,
          pending: { ...v.pending, acknowledged: true },
        }));
      }
    }
    await this.api.waitStatus(serverId, "deleted");
    return this.store.update(id, (v) => ({
      ...v,
      expiry: v.expiry
        ? {
            ...v.expiry,
            session: v.expiry.session
              ? {
                  ...v.expiry.session,
                  state: "released",
                  completedAt: new Date().toISOString(),
                }
              : null,
          }
        : undefined,
      previousVm: v.vm,
      vm: null,
      pending: null,
      hibernate: null,
      phase,
    }));
  }
}

function checkMinutes(minutes) {
  if (minutes !== 15)
    fail(
      "invalid_timeout",
      "Automatic hibernation requires 15 minutes of confirmed inactivity.",
    );
}
function expirySession(serverId) {
  const now = Date.now();
  return {
    id: randomUUID(),
    serverId,
    startedAt: new Date(now).toISOString(),
    expiresAt: null,
    activityState: "unknown",
    idleSince: null,
    lastObservedAt: null,
    activityToken: null,
    state: "scheduled",
  };
}

function idleObservation(session, activity, minutes, now) {
  const idle =
    activity?.state === "idle" &&
    typeof activity.token === "string" &&
    activity.token.length > 0;
  const previous = Date.parse(session.lastObservedAt);
  const continuous =
    idle &&
    session.activityToken === activity.token &&
    Number.isFinite(previous) &&
    now >= previous &&
    now - previous <= 90000;
  const idleSince = idle
    ? continuous && session.idleSince
      ? session.idleSince
      : new Date(now).toISOString()
    : null;
  return {
    ...session,
    state: "observing",
    releaseAuthorized: false,
    activityState: idle
      ? "idle"
      : ["working", "blocked"].includes(activity?.state)
        ? activity.state
        : "unknown",
    activityToken: idle ? activity.token : null,
    idleSince,
    lastObservedAt: new Date(now).toISOString(),
    expiresAt: idle
      ? new Date(
          Math.max(
            Date.parse(idleSince) + minutes * 60000,
            Date.parse(session.deferUntil) || 0,
          ),
        ).toISOString()
      : null,
  };
}
