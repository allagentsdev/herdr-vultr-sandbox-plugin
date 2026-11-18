import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/state.mjs";
import { Lifecycle } from "../src/lifecycle.mjs";
import { idleWorker } from "./fixtures/idle-worker.mjs";

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
  assert.notDeepEqual(stopped.hibernate.checkpoint, oldCheckpoint);
  const stoppedBytes = JSON.stringify(stopped),
    callsBefore = f.calls.length;
  await assert.rejects(
    f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${randomUUID()}`),
    { code: "approval_required" },
  );
  assert.equal(JSON.stringify(f.store.get(f.id)), stoppedBytes);
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
    await assert.rejects(
      f.life.disableExpiry(f.id, `DISABLE AUTO-HIBERNATE ${f.id}`),
      { code: "operation_pending" },
    );
    assert.equal(JSON.stringify(f.store.get(f.id)), before);
    assert.equal(f.calls.length, count);
    assert.equal((await f.api.getServer()).powerState, "off");
  }
});

test("Disable without Hibernate works with an enabled or already disabled policy", async (t) => {
  const f = await idleWorker(t),
    vm = f.store.get(f.id).vm;
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
