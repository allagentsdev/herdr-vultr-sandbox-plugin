import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/state.mjs";
import { Lifecycle } from "../src/lifecycle.mjs";
import { PluginError } from "../src/result.mjs";
import { Cloud } from "../src/provider.mjs";
import { idleWorker } from "./fixtures/idle-worker.mjs";

for (const action of ["Stop", "Hibernate"])
  test(`rejected ${action} retains running shutdown recovery when exact Disable is requested`, async (t) => {
    const f = await idleWorker(t);
    const oldCheckpoint = {
      workerId: f.id,
      currentSourceDigest: "c".repeat(64),
    };
    await f.store.update(f.id, (r) => ({
      ...r,
      snapshot: { ...r.snapshot, checkpoint: oldCheckpoint },
    }));
    const snapshot = JSON.stringify(f.store.get(f.id).snapshot);
    f.api.request = async (method, url, body) => {
      f.calls.push([method, url, body]);
      assert.equal(method, "POST");
      assert.equal(url, `/instances/${f.serverId}/halt`);
      const error = new PluginError(
        "provider_rejected",
        "Synthetic definitive rejection",
      );
      error.httpStatus = 403;
      throw error;
    };
    await assert.rejects(
      action === "Stop"
        ? f.life.power(f.id, "shutdown")
        : f.life.hibernate(f.id),
      { code: "provider_rejected" },
    );
    const rejected = f.store.get(f.id);
    assert.equal((await f.api.getServer()).powerState, "running");
    assert.equal(rejected.pending, null);
    assert.equal(rejected.hibernate.stage, "shutdown");
    assert.equal(rejected.lastRejectedOperation.httpStatus, 403);
    assert.equal(JSON.stringify(rejected.snapshot), snapshot);
    const before = JSON.stringify(rejected),
      count = f.calls.length;
    await assert.rejects(
      f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`),
      { code: "operation_pending" },
    );
    assert.equal(JSON.stringify(f.store.get(f.id)), before);
    assert.equal(f.calls.length, count);
  });

test("interrupted Hibernate after OFF cannot be discarded as a completed manual Stop", async (t) => {
  const f = await idleWorker(t),
    update = f.store.update.bind(f.store);
  f.store.update = (id, change) =>
    update(id, (r) => {
      const next = change(r);
      if (
        r.hibernate?.stage === "shutdown" &&
        next.hibernate?.stage === "snapshot"
      )
        throw new Error("Synthetic failure before snapshot stage persistence");
      return next;
    });
  await assert.rejects(
    f.life.hibernate(f.id),
    /before snapshot stage persistence/,
  );
  const r = f.store.get(f.id);
  assert.equal((await f.api.getServer()).powerState, "off");
  assert.equal(r.pending, null);
  assert.equal(r.hibernate.stage, "shutdown");
  const before = JSON.stringify(r),
    count = f.calls.length;
  await assert.rejects(
    f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`),
    { code: "operation_pending" },
  );
  assert.equal(JSON.stringify(f.store.get(f.id)), before);
  assert.equal(f.calls.length, count);
});

test("Hibernate takeover retires completed Stop authority before provider reads and stage advancement", async (t) => {
  for (const failure of [
    "provider-read",
    "snapshot-stage",
    "retirement-write",
  ]) {
    const f = await idleWorker(t);
    await f.life.power(f.id, "shutdown");
    const stopped = f.store.get(f.id),
      getServer = f.api.getServer,
      update = f.store.update.bind(f.store);
    assert.ok(stopped.hibernate.manualStop.completedAt);
    const before = JSON.stringify(stopped);
    let reads = 0;
    f.api.getServer = async () => {
      reads++;
      if (failure === "provider-read")
        throw new Error("Synthetic provider-read failure");
      return getServer();
    };
    f.store.update = (id, change) =>
      update(id, (r) => {
        const next = change(r);
        if (
          failure === "retirement-write" &&
          r.hibernate?.manualStop &&
          next.hibernate?.manualStop === null
        )
          throw new Error("Synthetic retirement-write failure");
        if (
          failure === "snapshot-stage" &&
          r.hibernate?.stage === "shutdown" &&
          next.hibernate?.stage === "snapshot"
        )
          throw new Error("Synthetic snapshot-stage failure");
        return next;
      });
    await assert.rejects(f.life.hibernate(f.id), new RegExp(failure));
    f.store.update = update;
    f.api.getServer = getServer;
    const after = f.store.get(f.id);
    if (failure === "retirement-write") {
      assert.equal(JSON.stringify(after), before);
      assert.equal(reads, 0);
    } else {
      assert.equal(after.hibernate.manualStop, null);
      assert.deepEqual(
        after.hibernate.checkpoint,
        stopped.hibernate.checkpoint,
      );
      await assert.rejects(
        f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`),
        { code: "operation_pending" },
      );
    }
    assert.deepEqual(after.snapshot, stopped.snapshot);
    assert.deepEqual(after.vm, stopped.vm);
  }
});

test("legacy and Hibernate shutdown recovery cannot gain manual Stop origin through public power recovery", async (t) => {
  for (const origin of ["legacy", "Hibernate"]) {
    const f = await idleWorker(t);
    if (origin === "legacy") {
      await f.life.power(f.id, "shutdown");
      await f.store.update(f.id, (r) => ({
        ...r,
        hibernate: { checkpoint: r.hibernate.checkpoint, stage: "shutdown" },
      }));
    } else {
      const request = f.api.request;
      f.api.request = async (...args) => {
        await request(...args);
        throw new PluginError(
          "outcome_unknown",
          "Synthetic lost Hibernate Halt response",
        );
      };
      await assert.rejects(f.life.hibernate(f.id), { code: "outcome_unknown" });
      assert.equal(f.store.get(f.id).pending.kind, "shutdown");
    }
    await f.life.power(f.id, "shutdown");
    assert.equal((await f.api.getServer()).powerState, "off");
    const r = f.store.get(f.id);
    assert.equal(r.pending, null);
    assert.equal(r.hibernate.manualStop, undefined);
    const before = JSON.stringify(r);
    f.api.getServer = async () =>
      assert.fail(
        "Unproven manual Stop origin must refuse before provider reads",
      );
    await assert.rejects(
      f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`),
      { code: "operation_pending" },
    );
    assert.equal(JSON.stringify(f.store.get(f.id)), before);
  }
});

test("manual Stop completion reconciles only its exact receipt and atomically clears pending", async (t) => {
  const f = await idleWorker(t),
    request = f.api.request;
  let attempts = 0;
  f.api.request = async (...args) => {
    attempts++;
    const r = f.store.get(f.id);
    assert.equal(r.hibernate.manualStop.operation, r.pending.operation);
    assert.equal(r.hibernate.manualStop.serverId, r.pending.serverId);
    assert.deepEqual(r.hibernate.manualStop.checkpoint, r.hibernate.checkpoint);
    assert.equal(r.hibernate.manualStop.completedAt, null);
    await request(...args);
    throw new PluginError(
      "outcome_unknown",
      "Synthetic lost manual Stop Halt response",
    );
  };
  await assert.rejects(f.life.power(f.id, "shutdown"), {
    code: "outcome_unknown",
  });
  const pending = f.store.get(f.id),
    update = f.store.update.bind(f.store);
  f.store.update = (id, change) =>
    update(id, (r) => {
      const next = change(r);
      if (r.pending && next.pending === null) {
        assert.equal(next.hibernate.manualStop.operation, r.pending.operation);
        assert.ok(next.hibernate.manualStop.completedAt);
        throw new Error("Synthetic completion persistence failure");
      }
      return next;
    });
  await assert.rejects(
    f.life.power(f.id, "shutdown"),
    /completion persistence failure/,
  );
  assert.deepEqual(f.store.get(f.id).pending, pending.pending);
  assert.equal(f.store.get(f.id).hibernate.manualStop.completedAt, null);
  f.store.update = update;
  await f.life.power(f.id, "shutdown");
  const completed = f.store.get(f.id);
  assert.equal(completed.pending, null);
  assert.equal(
    completed.hibernate.manualStop.operation,
    pending.pending.operation,
  );
  assert.equal(completed.hibernate.manualStop.serverId, f.serverId);
  assert.deepEqual(
    completed.hibernate.manualStop.checkpoint,
    pending.hibernate.checkpoint,
  );
  assert.ok(completed.hibernate.manualStop.completedAt);
  assert.equal(attempts, 1);
  await f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`);
  assert.equal(f.store.get(f.id).expiry, null);
});

test("manual Stop reconciliation refuses mismatched operation, server or checkpoint intent", async (t) => {
  for (const mismatch of ["operation", "serverId", "checkpoint"]) {
    const f = await idleWorker(t),
      request = f.api.request;
    f.api.request = async (...args) => {
      await request(...args);
      throw new PluginError(
        "outcome_unknown",
        "Synthetic lost manual Stop Halt response",
      );
    };
    await assert.rejects(f.life.power(f.id, "shutdown"), {
      code: "outcome_unknown",
    });
    await f.store.update(f.id, (r) => ({
      ...r,
      hibernate: {
        ...r.hibernate,
        manualStop: {
          ...r.hibernate.manualStop,
          [mismatch]:
            mismatch === "checkpoint"
              ? {
                  ...r.hibernate.checkpoint,
                  currentSourceDigest: "e".repeat(64),
                }
              : randomUUID(),
        },
      },
    }));
    const before = JSON.stringify(f.store.get(f.id)),
      calls = f.calls.length;
    await assert.rejects(f.life.power(f.id, "shutdown"), {
      code: "operation_pending",
    });
    assert.equal(JSON.stringify(f.store.get(f.id)), before);
    assert.equal(f.calls.length, calls);
  }
});

test("shutdown-stage Disable requires a fresh owned OFF observation and retains every unconfirmed recovery", async (t) => {
  for (const scenario of [
    "running",
    "transitioning",
    "unconfirmed",
    "missing",
    "missing-vm",
    "wrong-id",
    "wrong-tags",
    "blocks",
    "read-failure",
  ]) {
    const f = await idleWorker(t);
    await f.life.power(f.id, "shutdown");
    const server = { ...(await f.api.getServer()) };
    let reads = 0;
    f.api.getServer = async () => {
      reads++;
      if (scenario === "read-failure")
        throw new PluginError("outcome_unknown", "Synthetic read failure");
      if (scenario === "missing") return null;
      if (scenario === "wrong-id") return { ...server, id: randomUUID() };
      if (scenario === "wrong-tags") return { ...server, tags: [] };
      if (scenario === "blocks") return { ...server, volumes: [randomUUID()] };
      return {
        ...server,
        powerState: scenario === "unconfirmed" ? undefined : scenario,
      };
    };
    if (scenario === "missing-vm")
      await f.store.update(f.id, (r) => ({ ...r, vm: null }));
    const before = JSON.stringify(f.store.get(f.id)),
      count = f.calls.length;
    const code =
      scenario === "wrong-id" || scenario === "wrong-tags"
        ? "ownership_mismatch"
        : scenario === "blocks"
          ? "volumes_unsupported"
          : scenario === "read-failure"
            ? "outcome_unknown"
            : "operation_pending";
    await assert.rejects(
      f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`),
      { code },
    );
    assert.equal(JSON.stringify(f.store.get(f.id)), before, scenario);
    assert.equal(f.calls.length, count, scenario);
    assert.equal(reads, scenario === "missing-vm" ? 0 : 1, scenario);
  }
});

test("shutdown-stage Disable uses actual Vultr stopped/unlocked normalization before revoking release", async (t) => {
  const f = await idleWorker(t);
  await f.life.power(f.id, "shutdown");
  const server = await f.api.getServer();
  let serverStatus = "locked";
  const calls = [];
  f.life.api = new Cloud("synthetic-unused-account-token", {
    fetch: async (url, options) => {
      calls.push([options.method, url]);
      assert.equal(options.method, "GET");
      const body = url.endsWith("/blocks?per_page=100")
        ? { blocks: [], meta: { links: {} } }
        : {
            instance: {
              ...server,
              status: "active",
              server_status: serverStatus,
              power_status: "stopped",
            },
          };
      return new Response(JSON.stringify(body));
    },
  });
  const before = JSON.stringify(f.store.get(f.id));
  await assert.rejects(
    f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`),
    { code: "operation_pending" },
  );
  assert.equal(JSON.stringify(f.store.get(f.id)), before);
  serverStatus = "ok";
  await f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`);
  assert.equal(f.store.get(f.id).expiry, null);
  assert.equal(f.store.get(f.id).hibernate, null);
  assert.deepEqual(calls, [
    ["GET", `https://api.vultr.com/v2/instances/${f.serverId}`],
    ["GET", "https://api.vultr.com/v2/blocks?per_page=100"],
    ["GET", `https://api.vultr.com/v2/instances/${f.serverId}`],
    ["GET", "https://api.vultr.com/v2/blocks?per_page=100"],
  ]);
});

test("exact Disable after consented normal Stop retains OFF compute and latest checkpoint while revoking release", async (t) => {
  const f = await idleWorker(t);
  const oldCheckpoint = {
    workerId: f.id,
    sourceDigest: "a".repeat(64),
    currentSourceDigest: "c".repeat(64),
    at: "2026-11-17T00:00:00.000Z",
  };
  await f.store.update(f.id, (r) => ({
    ...r,
    snapshot: { ...r.snapshot, checkpoint: oldCheckpoint },
  }));
  const oldSnapshotBytes = JSON.stringify(f.store.get(f.id).snapshot);
  await f.life.power(f.id, "shutdown");
  const stopped = f.store.get(f.id),
    oldSession = stopped.expiry.session;
  assert.equal((await f.api.getServer()).powerState, "off");
  assert.equal(stopped.pending, null);
  assert.equal(stopped.hibernate.stage, "shutdown");
  assert.equal(stopped.hibernate.manualStop.serverId, f.serverId);
  assert.deepEqual(
    stopped.hibernate.manualStop.checkpoint,
    stopped.hibernate.checkpoint,
  );
  assert.equal(typeof stopped.hibernate.manualStop.operation, "string");
  assert.ok(
    Number.isFinite(Date.parse(stopped.hibernate.manualStop.completedAt)),
  );
  assert.notDeepEqual(stopped.hibernate.checkpoint, oldCheckpoint);
  const stoppedBytes = JSON.stringify(stopped),
    callsBefore = f.calls.length;
  const getServer = f.api.getServer;
  f.api.getServer = async () =>
    assert.fail("Wrong confirmation must precede provider reads");
  await assert.rejects(
    f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${randomUUID()}`),
    { code: "approval_required" },
  );
  assert.equal(JSON.stringify(f.store.get(f.id)), stoppedBytes);
  f.api.getServer = getServer;
  const update = f.store.update.bind(f.store);
  f.store.update = (id, fn) =>
    update(id, (record) => {
      const next = fn(record);
      if (record.hibernate && next.hibernate === null)
        assert.equal(
          next.expiry,
          null,
          "retiring Hibernate authority also revokes policy in the same durable update",
        );
      if (record.expiry && next.expiry === null) {
        assert.equal(
          next.hibernate,
          null,
          "revocation retires Hibernate authority in the same durable update",
        );
        assert.deepEqual(next.powerCheckpoint, stopped.hibernate.checkpoint);
      }
      return next;
    });
  await f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`);
  const disabled = f.store.get(f.id);
  assert.equal(disabled.expiry, null);
  assert.equal(disabled.hibernate, null);
  assert.deepEqual(disabled.vm, stopped.vm);
  assert.deepEqual(disabled.powerCheckpoint, stopped.hibernate.checkpoint);
  assert.equal(JSON.stringify(disabled.snapshot), oldSnapshotBytes);
  assert.equal((await f.api.getServer()).powerState, "off");
  const disabledBytes = JSON.stringify(disabled);
  await f.life.expire(f.id, oldSession.id, f.now + 1e9);
  assert.equal(JSON.stringify(f.store.get(f.id)), disabledBytes);
  await assert.rejects(
    f.life.release(f.id, `DELETE ${f.serverId} SNAPSHOT ${f.oldImageId}`),
    { code: "approval_required" },
  );
  assert.equal(JSON.stringify(f.store.get(f.id)), disabledBytes);
  assert.equal(f.calls.length, callsBefore);
});

test("Disable preserves pending receipts and snapshot, release or unknown Hibernate stages", async (t) => {
  for (const condition of [
    "pending-unattempted",
    "pending-unknown",
    "pending-acknowledged",
    "snapshot",
    "release",
    "unknown",
    "missing-stage",
  ]) {
    const f = await idleWorker(t);
    await f.life.power(f.id, "shutdown");
    await f.store.update(f.id, (r) => ({
      ...r,
      ...(condition.startsWith("pending-")
        ? {
            pending: {
              kind: "shutdown",
              serverId: f.serverId,
              attempted: condition !== "pending-unattempted",
              acknowledged: condition === "pending-acknowledged",
            },
          }
        : {
            hibernate: {
              checkpoint: r.hibernate.checkpoint,
              ...(condition === "missing-stage" ? {} : { stage: condition }),
            },
          }),
    }));
    const before = JSON.stringify(f.store.get(f.id)),
      count = f.calls.length;
    f.api.getServer = async () =>
      assert.fail("Pending/stage refusal must precede provider reads");
    await assert.rejects(
      f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`),
      { code: "operation_pending" },
    );
    assert.equal(JSON.stringify(f.store.get(f.id)), before);
    assert.equal(f.calls.length, count);
  }
});

test("Disable without Hibernate works with an enabled or already disabled policy", async (t) => {
  const f = await idleWorker(t),
    vm = f.store.get(f.id).vm;
  f.api.getServer = async () =>
    assert.fail("Plain Disable must not read the provider");
  for (let i = 0; i < 2; i++) {
    await f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`);
    assert.equal(f.store.get(f.id).expiry, null);
    assert.deepEqual(f.store.get(f.id).vm, vm);
    assert.equal(f.calls.length, 0);
  }
});

test("Disable retains the latest shutdown checkpoint when an older power checkpoint is present", async (t) => {
  const f = await idleWorker(t);
  await f.life.power(f.id, "shutdown");
  const latest = f.store.get(f.id).hibernate.checkpoint;
  await f.store.update(f.id, (r) => ({
    ...r,
    powerCheckpoint: { ...latest, currentSourceDigest: "e".repeat(64) },
  }));
  await f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`);
  assert.deepEqual(f.store.get(f.id).powerCheckpoint, latest);
  assert.equal(f.store.get(f.id).hibernate, null);
});

test("recurring consent is exact-worker and only the 15 minute idle policy is accepted", async (t) => {
  const f = await idleWorker(t);
  await f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`);
  for (const minutes of [0, 1, 14, 16, "15", null])
    await assert.rejects(
      f.life.configureExpiry(f.id, minutes, `AUTO-HIBERNATE ${f.id}`),
      { code: "invalid_timeout" },
    );
  await assert.rejects(
    f.life.configureExpiry(f.id, 15, `AUTO-HIBERNATE ${randomUUID()}`),
    { code: "approval_required" },
  );
  assert.equal(f.store.get(f.id).expiry, null);
  await f.life.expire(f.id, randomUUID(), f.now + 1e9);
  assert.deepEqual(f.calls, []);
});

test("idle release verifies a fresh complete Vultr image and OFF before exact delete; released jobs are inert", async (t) => {
  const f = await idleWorker(t);
  await f.poll();
  await f.tick(15);
  const r = f.store.get(f.id);
  assert.equal(r.vm, null);
  assert.equal(r.snapshot.imageId, f.imageId);
  assert.equal(r.snapshot.previousImageId, f.oldImageId);
  assert.equal(r.expiry.session.state, "released");
  assert.deepEqual(f.calls.slice(0, 3), [
    "quiesce",
    "prepareSnapshot",
    ["POST", `/instances/${f.serverId}/halt`, undefined],
  ]);
  const snapshot = f.calls.findIndex((c) => c[1] === "/snapshots");
  assert.ok(snapshot < f.calls.findIndex((c) => c[0] === "DELETE"));
  assert.equal(f.calls[snapshot][2].instance_id, f.serverId);
  const count = f.calls.length;
  await f.life.expire(f.id, r.expiry.session.id, f.now + 1e9);
  assert.equal(f.calls.length, count);
});

test("snapshot failure retains the VM and good image; controller restart observes without repeating create", async (t) => {
  const f = await idleWorker(t),
    wait = f.api.waitSnapshot;
  f.api.waitSnapshot = async () => ({ ...(await wait()), status: "pending" });
  await f.poll();
  await assert.rejects(f.tick(15), { code: "snapshot_unusable" });
  assert.equal(f.store.get(f.id).snapshot.imageId, f.oldImageId);
  assert.equal(f.store.get(f.id).vm.serverId, f.serverId);
  assert.equal(
    f.calls.some((c) => c[0] === "DELETE"),
    false,
  );
  f.api.waitSnapshot = wait;
  await new Lifecycle(new Store(f.store.directory), f.api, f.remote).expire(
    f.id,
    f.store.get(f.id).expiry.session.id,
    f.now,
  );
  assert.equal(f.store.get(f.id).vm, null);
  assert.equal(f.calls.filter((c) => c[1] === "/snapshots").length, 1);
});

test("lost automatic snapshot or delete response is reconciled without duplicate mutations", async (t) => {
  for (const kind of ["snapshot", "delete"]) {
    const f = await idleWorker(t),
      request = f.api.request;
    f.api.request = async (method, url, body) => {
      const result = await request(method, url, body);
      if (
        (kind === "snapshot" && url === "/snapshots") ||
        (kind === "delete" && method === "DELETE")
      )
        throw Object.assign(Error("lost"), { code: "outcome_unknown" });
      return result;
    };
    await f.poll();
    await assert.rejects(f.tick(15), { code: "outcome_unknown" });
    await new Lifecycle(new Store(f.store.directory), f.api, f.remote).expire(
      f.id,
      f.store.get(f.id).expiry.session.id,
      f.now,
    );
    assert.equal(f.store.get(f.id).vm, null);
    assert.equal(f.calls.filter((c) => c[1] === "/snapshots").length, 1);
    assert.equal(f.calls.filter((c) => c[0] === "DELETE").length, 1);
  }
});

test("consented Stop prepares the clone and checkpoint before Halt; later idle release never starts the OFF VM", async (t) => {
  const f = await idleWorker(t);
  await f.life.power(f.id, "shutdown");
  assert.equal(
    f.store.get(f.id).hibernate.checkpoint.currentSourceDigest,
    f.digest,
  );
  assert.deepEqual(f.calls, [
    "quiesce",
    "prepareSnapshot",
    ["POST", `/instances/${f.serverId}/halt`, undefined],
  ]);
  await f.poll();
  await f.tick(15);
  assert.equal(f.store.get(f.id).vm, null);
  assert.equal(
    f.calls.some((c) => c[1]?.endsWith("/start")),
    false,
  );
});

test("fixed 15 minute deferral moves only the idle floor; unknown remains protected", async (t) => {
  const f = await idleWorker(t);
  await f.poll();
  const previous = f.store.get(f.id).expiry.session;
  await f.life.extendExpiry(f.id, 15);
  assert.equal(
    Date.parse(f.store.get(f.id).expiry.session.deferUntil),
    Date.parse(previous.expiresAt) + 15 * 60000,
  );
  await f.tick(15);
  assert.equal(f.calls.length, 0);
  f.activity = { state: "unknown" };
  await f.tick(30);
  assert.equal(f.store.get(f.id).expiry.session.expiresAt, null);
  assert.equal(f.calls.length, 0);
});

test("stale target jobs and unsubmitted power-on cannot mutate a replacement", async (t) => {
  for (const stale of [false, true]) {
    const f = await idleWorker(t),
      session = f.store.get(f.id).expiry.session;
    await f.store.update(f.id, (r) => ({
      ...r,
      vm: { ...r.vm, serverId: stale ? randomUUID() : f.serverId },
      pending: { kind: "poweron", serverId: r.vm.serverId, attempted: false },
    }));
    const get = f.api.getServer;
    f.api.getServer = async () => ({ ...(await get()), powerState: "off" });
    await assert.rejects(f.life.expire(f.id, session.id, f.now), {
      code: stale ? "expiry_target_changed" : "operation_pending",
    });
    assert.equal(f.calls.length, 0);
  }
});

test("restore binds a fresh unknown session before allocation and ignores an old job", async (t) => {
  const f = await idleWorker(t),
    old = f.store.get(f.id).expiry.session;
  await f.poll();
  await f.tick(15);
  const request = f.api.request;
  f.api.request = async (method, url, body) => {
    assert.equal(url, "/instances");
    const current = f.store.get(f.id).expiry.session;
    assert.notEqual(current.id, old.id);
    assert.equal(current.serverId, null);
    assert.equal(current.expiresAt, null);
    assert.equal(current.activityState, "unknown");
    return request(method, url, body);
  };
  await f.life.create(f.id, "ssh-ed25519 AAAA");
  const r = f.store.get(f.id);
  assert.notEqual(r.vm.serverId, f.serverId);
  assert.equal(r.expiry.session.serverId, r.vm.serverId);
  await f.life.expire(f.id, old.id, f.now + 1e9);
  assert.equal(f.store.get(f.id).vm.serverId, r.vm.serverId);
});

test("image recheck, ownership, and blocks retain compute during automatic release", async (t) => {
  for (const problem of ["image", "owner", "blocks", "off"]) {
    const f = await idleWorker(t);
    await f.poll();
    await f.tick(14);
    if (problem === "image")
      f.api.getImage = async () => ({ status: "pending" });
    else {
      const wait = f.api.waitSnapshot,
        get = f.api.getServer;
      f.api.waitSnapshot = async () => {
        const image = await wait();
        f.api.getServer = async () => ({
          ...(await get()),
          ...(problem === "owner"
            ? { tags: [] }
            : problem === "blocks"
              ? { volumes: ["block"] }
              : { powerState: "running" }),
        });
        return image;
      };
    }
    await assert.rejects(f.tick(1));
    assert.equal(f.store.get(f.id).vm.serverId, f.serverId);
    assert.equal(
      f.calls.some((c) => c[0] === "DELETE"),
      false,
    );
  }
});

test("unknown restore create binds the existing tagged allocation without a second POST or fresh session", async (t) => {
  const f = await idleWorker(t);
  await f.poll();
  await f.tick(15);
  const request = f.api.request;
  f.api.request = async (method, url, body) => {
    const result = await request(method, url, body);
    if (url === "/instances")
      throw Object.assign(Error("lost create"), { code: "outcome_unknown" });
    return result;
  };
  await assert.rejects(f.life.create(f.id, "ssh-ed25519 AAAA"), {
    code: "outcome_unknown",
  });
  const session = f.store.get(f.id).expiry.session;
  assert.equal(session.serverId, null);
  f.life = new Lifecycle(new Store(f.store.directory), f.api, f.remote);
  await f.poll();
  const r = f.store.get(f.id);
  assert.equal(r.expiry.session.id, session.id);
  assert.equal(r.expiry.session.serverId, r.vm.serverId);
  assert.equal(f.calls.filter((call) => call[1] === "/instances").length, 1);
});

test("uncertain automatic Halt or invisible snapshot never repeats mutation or discards the good image", async (t) => {
  for (const operation of ["halt", "snapshot"]) {
    const f = await idleWorker(t),
      request = f.api.request;
    let attempts = 0;
    f.api.request = async (method, url, body) => {
      if (operation === "halt" ? url.endsWith("/halt") : url === "/snapshots") {
        attempts++;
        throw Object.assign(Error("outcome not visible"), {
          code: "outcome_unknown",
        });
      }
      return request(method, url, body);
    };
    await f.poll();
    await assert.rejects(f.tick(15), { code: "outcome_unknown" });
    await assert.rejects(f.poll(), { code: "outcome_unknown" });
    assert.equal(attempts, 1);
    assert.equal(f.store.get(f.id).snapshot.imageId, f.oldImageId);
    assert.equal(f.store.get(f.id).vm.serverId, f.serverId);
    assert.equal(
      f.calls.some((c) => c[0] === "DELETE"),
      false,
    );
    assert.equal(f.calls.filter((c) => c === "quiesce").length, 1);
  }
});

test("consented Stop clone preparation failure retains running compute without stale quiescent authority", async (t) => {
  const f = await idleWorker(t);
  f.remote.prepareSnapshot = async () => {
    throw Error("clone preparation failed");
  };
  await assert.rejects(
    f.life.power(f.id, "shutdown"),
    /clone preparation failed/,
  );
  assert.equal(f.store.get(f.id).hibernate, undefined);
  assert.equal(f.store.get(f.id).pending, undefined);
  assert.equal(
    f.calls.some((c) => c[0] === "POST"),
    false,
  );
  assert.equal(f.store.get(f.id).snapshot.imageId, f.oldImageId);
});
