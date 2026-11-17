import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/state.mjs";
import { Lifecycle } from "../src/lifecycle.mjs";
import { temporary } from "./helpers.mjs";
async function fixture(t) {
  const store = new Store(temporary(t)),
    id = randomUUID(),
    calls = [];
  await store.create({
    id,
    namespace: "test",
    localRoot: temporary(t),
    config: {
      plan: "vc2-2c-4gb",
      region: "syd",
      osId: 2284,
      hostKeyMode: "provisioned",
    },
    vm: { serverId: "vm", disk: 80, plan: "vc2-2c-4gb", hostKey: "public-pin" },
    snapshot: { imageId: "old" },
    phase: "ready",
  });
  let power = "running",
    exists = true,
    snapshot;
  const api = {
    async getServer() {
      return exists
        ? {
            id: "vm",
            powerState: power,
            volumes: [],
            tags: ["herdr-plugin=vultr.sandbox", `herdr-worker=${id}`],
            main_ip: "192.0.2.1",
            disk: 80,
            plan: "vc2-2c-4gb",
          }
        : null;
    },
    async request(method, url, body) {
      calls.push({ method, url, body });
      if (method === "DELETE") exists = false;
      if (url === "/snapshots") {
        snapshot = {
          id: "snap",
          status: "complete",
          size: 123,
          os_id: 2284,
          description: body.description,
        };
        return { snapshot };
      }
      if (url.endsWith("/start")) power = "running";
      return {};
    },
    async find(type, labels) {
      return type === "snapshots" &&
        snapshot?.description === labels.description
        ? [snapshot]
        : [];
    },
    async waitStatus(id, status) {
      assert.equal(exists ? power : "deleted", status);
      return this.getServer();
    },
    async waitSnapshot() {
      return snapshot;
    },
    async getImage() {
      return snapshot;
    },
  };
  const remote = {
    async quiesce() {
      calls.push("quiesce");
    },
    async checkpoint() {
      calls.push("checkpoint");
      return {
        workerId: id,
        sourceDigest: "a".repeat(64),
        currentSourceDigest: "b".repeat(64),
        at: "2026-11-18T00:00:00Z",
      };
    },
    async prepareSnapshot() {
      calls.push("prepareSnapshot");
    },
    async shutdown() {
      calls.push("shutdown");
      power = "off";
    },
  };
  return {
    store,
    id,
    calls,
    api,
    remote,
    life: new Lifecycle(store, api, remote),
    setPower: (p) => (power = p),
  };
}
test("hibernate quiesces and checkpoints, cleans cloud-init and gracefully shuts down before snapshot and exact release", async (t) => {
  const f = await fixture(t);
  const result = await f.life.hibernate(f.id);
  assert.deepEqual(f.calls.slice(0, 4), [
    "quiesce",
    "checkpoint",
    "prepareSnapshot",
    "shutdown",
  ]);
  assert.equal(result.confirmation, "DELETE vm SNAPSHOT snap");
  assert.equal(
    f.calls.some((c) => c.method === "DELETE"),
    false,
  );
  await assert.rejects(f.life.release(f.id, "DELETE other SNAPSHOT snap"), {
    code: "approval_required",
  });
  await f.life.release(f.id, result.confirmation);
  assert.equal(f.store.get(f.id).vm, null);
  assert.equal(f.store.get(f.id).snapshot.imageId, "snap");
  assert.equal(f.store.get(f.id).id, f.id);
});
test("incomplete and mismatched snapshot retain instance and previous usable copy", async (t) => {
  for (const problem of ["pending", "description", "os", "size"]) {
    const f = await fixture(t),
      original = f.api.waitSnapshot;
    f.api.waitSnapshot = async () => ({
      ...(await original()),
      ...[
        { status: "pending" },
        { description: "foreign" },
        { os_id: 1743 },
        { size: 0 },
      ][["pending", "description", "os", "size"].indexOf(problem)],
    });
    await assert.rejects(f.life.hibernate(f.id), { code: "snapshot_unusable" });
    assert.equal(f.store.get(f.id).snapshot.imageId, "old");
    assert.equal(
      f.calls.some((c) => c.method === "DELETE"),
      false,
    );
  }
});
test("unknown snapshot create reconciles exact description and never blindly repeats", async (t) => {
  const f = await fixture(t),
    request = f.api.request;
  let submits = 0;
  f.api.request = async (...args) => {
    if (args[1] === "/snapshots") {
      submits++;
      await request(...args);
      throw Object.assign(Error("lost"), { code: "outcome_unknown" });
    }
    return request(...args);
  };
  await assert.rejects(f.life.hibernate(f.id), { code: "outcome_unknown" });
  await f.life.hibernate(f.id);
  assert.equal(submits, 1);
  const g = await fixture(t);
  g.api.request = async () => {
    throw Object.assign(Error("lost"), { code: "outcome_unknown" });
  };
  await assert.rejects(g.life.hibernate(g.id));
  await assert.rejects(g.life.hibernate(g.id), { code: "outcome_unknown" });
});
test("lost power request only observes status; Start never restarts an already running VM", async (t) => {
  const f = await fixture(t);
  await f.life.power(f.id, "poweron");
  assert.deepEqual(f.calls, []);
  f.setPower("off");
  f.api.request = async () => {
    throw Object.assign(Error("lost"), { code: "outcome_unknown" });
  };
  await assert.rejects(f.life.power(f.id, "poweron"));
  await assert.rejects(f.life.power(f.id, "poweron"), {
    code: "outcome_unknown",
  });
  f.setPower("running");
  await f.life.power(f.id, "poweron");
  assert.equal(f.store.get(f.id).pending, null);
});
test("missing mapped VM is never silently replaced", async (t) => {
  const f = await fixture(t);
  f.api.getServer = async () => null;
  await assert.rejects(f.life.create(f.id, "ssh-ed25519 AAAA"), {
    code: "server_missing",
  });
  assert.deepEqual(f.calls, []);
});
test("ownership and blocks prevent mutations, status exposes billable power off", async (t) => {
  const f = await fixture(t),
    get = f.api.getServer;
  f.api.getServer = async () => ({ ...(await get()), volumes: ["block"] });
  assert.deepEqual((await f.life.status(f.id)).volumes, ["block"]);
  await assert.rejects(f.life.power(f.id, "shutdown"), {
    code: "volumes_unsupported",
  });
  f.api.getServer = async () => ({
    ...(await get()),
    tags: ["herdr-worker=foreign"],
  });
  await assert.rejects(f.life.power(f.id, "shutdown"), {
    code: "ownership_mismatch",
  });
  assert.deepEqual(f.calls, []);
  f.api.getServer = get;
  f.setPower("off");
  assert.match((await f.life.status(f.id)).billing, /billed/);
});
test("lost delete response retains exact approval and reconciles absence without second DELETE", async (t) => {
  const f = await fixture(t),
    request = f.api.request;
  let submits = 0;
  f.api.request = async (...args) => {
    if (args[0] === "DELETE") {
      submits++;
      await request(...args);
      throw Object.assign(Error("lost"), { code: "outcome_unknown" });
    }
    return request(...args);
  };
  await assert.rejects(f.life.deleteServer(f.id, "DELETE vm"));
  assert.ok(f.store.get(f.id).vm);
  await f.life.deleteServer(f.id, "DELETE vm");
  assert.equal(submits, 1);
  assert.equal(f.store.get(f.id).vm, null);
});
test("release refuses checkpoint tampering and snapshot description changes", async (t) => {
  const f = await fixture(t);
  await f.life.hibernate(f.id);
  await f.store.update(f.id, (r) => ({
    ...r,
    snapshot: { ...r.snapshot, checkpoint: null },
  }));
  await assert.rejects(f.life.release(f.id, "DELETE vm SNAPSHOT snap"), {
    code: "checkpoint_missing",
  });
  assert.equal(
    f.calls.some((c) => c.method === "DELETE"),
    false,
  );
});

test("ordinary power-off retains a durable checkpoint before shutdown and never uses force halt", async (t) => {
  const f = await fixture(t);
  await f.life.power(f.id, "shutdown");
  assert.deepEqual(f.calls, ["quiesce", "checkpoint", "shutdown"]);
  assert.equal(f.store.get(f.id).powerCheckpoint.workerId, f.id);
  assert.equal(f.store.get(f.id).vm.serverId, "vm");
});
test("unknown guest shutdown acknowledgement cannot repeat hooks or replay shutdown", async (t) => {
  const f = await fixture(t);
  f.remote.shutdown = async () => {
    throw Object.assign(Error("lost"), { code: "outcome_unknown" });
  };
  await assert.rejects(f.life.power(f.id, "shutdown"));
  await assert.rejects(f.life.power(f.id, "shutdown"), {
    code: "outcome_unknown",
  });
  assert.deepEqual(f.calls, ["quiesce", "checkpoint"]);
  f.setPower("off");
  await f.life.power(f.id, "shutdown");
  assert.equal(f.store.get(f.id).pending, null);
});
test("transitioning power status never sends potentially restarting Start", async (t) => {
  const f = await fixture(t);
  f.setPower("transitioning");
  await assert.rejects(f.life.power(f.id, "poweron"), {
    code: "status_pending",
  });
  assert.deepEqual(f.calls, []);
});
