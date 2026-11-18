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
      if (url.endsWith("/halt")) power = "off";
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
      // Guest shutdown acknowledgement is independent of provider power.
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
test("hibernate quiesces and checkpoints, cleans cloud-init then uses provider Stop before snapshot and exact release", async (t) => {
  const f = await fixture(t);
  const result = await f.life.hibernate(f.id);
  assert.deepEqual(f.calls.slice(0, 4), [
    "quiesce",
    "checkpoint",
    "prepareSnapshot",
    { method: "POST", url: "/instances/vm/halt", body: undefined },
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
  const gRequest = g.api.request;
  g.api.request = async (...args) => {
    if (args[1].endsWith("/halt")) return gRequest(...args);
    throw Object.assign(Error("lost"), { code: "outcome_unknown" });
  };
  await assert.rejects(g.life.hibernate(g.id));
  assert.equal(g.store.get(g.id).pending.kind, "snapshot");
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
test("release refuses checkpoint tampering before deletion", async (t) => {
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

test("ordinary Stop retains a durable checkpoint before exact provider Stop and observes OFF", async (t) => {
  const f = await fixture(t);
  await f.life.power(f.id, "shutdown");
  assert.deepEqual(f.calls, [
    "quiesce",
    "checkpoint",
    { method: "POST", url: "/instances/vm/halt", body: undefined },
  ]);
  assert.equal(f.store.get(f.id).powerCheckpoint.workerId, f.id);
  assert.equal(f.store.get(f.id).vm.serverId, "vm");
});
test("unknown provider Stop acknowledgement cannot repeat hooks or replay Stop", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  f.api.request = async () => {
    attempts++;
    throw Object.assign(Error("lost"), { code: "outcome_unknown" });
  };
  await assert.rejects(f.life.power(f.id, "shutdown"));
  await assert.rejects(f.life.power(f.id, "shutdown"), {
    code: "outcome_unknown",
  });
  assert.deepEqual(f.calls, ["quiesce", "checkpoint"]);
  assert.equal(attempts, 1);
  assert.equal(f.store.get(f.id).pending.acknowledged, undefined);
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

test("definitive provider rejections retain a terminal receipt and allow only the next explicit retry", async (t) => {
  const { Cloud } = await import("../src/provider.mjs");
  for (const kind of ["shutdown", "poweron", "snapshot", "delete", "create"]) {
    const f = await fixture(t);
    if (kind === "poweron") f.setPower("off");
    if (kind === "create")
      await f.store.update(f.id, (r) => ({ ...r, vm: null, snapshot: null }));
    const request = f.api.request;
    let attempts = 0,
      created;
    if (kind === "create") {
      f.api.getServer = async () => created ?? null;
      f.api.waitStatus = async () => created;
    }
    f.api.request = async (method, url, body) => {
      if (kind === "snapshot" && url.endsWith("/halt"))
        return request(method, url, body);
      attempts++;
      if (attempts === 1)
        return new Cloud("fake", {
          fetch: async () => new Response("{}", { status: 429 }),
        }).request(method, url, body);
      if (kind === "create") {
        created = {
          id: "new-vm",
          plan: "vc2-2c-4gb",
          disk: 80,
          main_ip: "192.0.2.1",
          powerState: "running",
          volumes: [],
          tags: body.tags,
        };
        return { instance: created };
      }
      return request(method, url, body);
    };
    const invoke = () =>
      kind === "create"
        ? f.life.create(f.id, "ssh-ed25519 AAAA")
        : kind === "snapshot"
          ? f.life.hibernate(f.id)
          : kind === "delete"
            ? f.life.deleteServer(f.id, "DELETE vm")
            : f.life.power(f.id, kind);
    await assert.rejects(invoke(), { code: "provider_rejected" });
    const rejected = f.store.get(f.id);
    assert.equal(rejected.pending, null);
    assert.equal(
      rejected.lastRejectedOperation.kind,
      kind === "poweron" ? "poweron" : kind,
    );
    assert.equal(rejected.lastRejectedOperation.httpStatus, 429);
    assert.equal(attempts, 1, "No retry in the failed call");
    await invoke();
    assert.equal(attempts, 2);
  }
});
test("release re-fetch refuses a changed snapshot description before DELETE", async (t) => {
  const f = await fixture(t);
  await f.life.hibernate(f.id);
  const get = f.api.getImage;
  f.api.getImage = async () => ({
    ...(await get()),
    description: "foreign operation",
  });
  await assert.rejects(f.life.release(f.id, "DELETE vm SNAPSHOT snap"), {
    code: "snapshot_unusable",
  });
  assert.equal(
    f.calls.some((c) => c.method === "DELETE"),
    false,
  );
});

test("rejected snapshot restore preserves hibernated phase and recovery identity", async (t) => {
  const { Cloud } = await import("../src/provider.mjs");
  const f = await fixture(t);
  await f.store.update(f.id, (r) => ({
    ...r,
    vm: null,
    phase: "hibernated",
    snapshot: {
      imageId: "saved",
      description: "saved-operation",
      plan: r.config.plan,
      disk: 80,
    },
  }));
  f.api.getImage = async () => ({
    id: "saved",
    description: "saved-operation",
    status: "complete",
    os_id: 2284,
    size: 123,
  });
  f.api.request = (method, url, body) =>
    new Cloud("fake", {
      fetch: async () => new Response("{}", { status: 401 }),
    }).request(method, url, body);
  await assert.rejects(f.life.create(f.id, "ssh-ed25519 AAAA"), {
    code: "provider_rejected",
  });
  const saved = f.store.get(f.id);
  assert.equal(saved.phase, "hibernated");
  assert.equal(saved.snapshot.imageId, "saved");
  assert.equal(saved.pending, null);
});

test("Stop persists checkpoint, target and attempted provider intent before request; acknowledgement waits for observed OFF", async (t) => {
  for (const hibernate of [false, true]) {
    const f = await fixture(t),
      request = f.api.request,
      waitStatus = f.api.waitStatus;
    let stops = 0;
    f.api.request = async (method, url, body) => {
      if (url.endsWith("/halt")) {
        stops++;
        const saved = f.store.get(f.id);
        assert.deepEqual(
          f.calls,
          hibernate
            ? ["quiesce", "checkpoint", "prepareSnapshot"]
            : ["quiesce", "checkpoint"],
        );
        assert.equal(
          (hibernate ? saved.hibernate.checkpoint : saved.powerCheckpoint)
            .workerId,
          f.id,
        );
        assert.equal(saved.pending.kind, "shutdown");
        assert.equal(saved.pending.serverId, "vm");
        assert.equal(saved.pending.providerOperation, "halt");
        assert.equal(saved.pending.attempted, true);
        assert.ok(Number.isFinite(Date.parse(saved.pending.started)));
        assert.equal(saved.pending.acknowledged, undefined);
        assert.equal(method, "POST");
        assert.equal(url, "/instances/vm/halt");
        assert.equal(body, undefined);
      }
      return request(method, url, body);
    };
    f.api.waitStatus = async (id, status) => {
      assert.equal(f.store.get(f.id).pending.acknowledged, true);
      assert.equal(
        f.calls.some((c) => c.url === "/snapshots"),
        false,
      );
      return waitStatus.call(f.api, id, status);
    };
    if (hibernate) await f.life.hibernate(f.id);
    else await f.life.power(f.id, "shutdown");
    assert.equal(stops, 1);
  }
});

test("failed acknowledgement persistence or OFF observation retains Stop without any second request", async (t) => {
  for (const failure of ["acknowledgement", "observation"]) {
    const f = await fixture(t),
      update = f.store.update.bind(f.store),
      request = f.api.request;
    let attempts = 0;
    f.api.request = async (...args) => {
      attempts++;
      await request(...args);
      f.setPower("running");
      return {};
    };
    if (failure === "acknowledgement")
      f.store.update = (id, fn) =>
        update(id, (record) => {
          const next = fn(record);
          if (next.pending?.acknowledged)
            throw Error("acknowledgement write failed");
          return next;
        });
    f.api.waitStatus = async () => {
      throw Object.assign(Error("not observed off"), {
        code: "status_pending",
      });
    };
    await assert.rejects(f.life.power(f.id, "shutdown"));
    f.store.update = update;
    const receipt = f.store.get(f.id).pending;
    assert.equal(receipt.attempted, true);
    assert.equal(receipt.acknowledged ?? false, failure === "observation");
    await assert.rejects(f.life.power(f.id, "shutdown"), {
      code:
        failure === "acknowledgement" ? "outcome_unknown" : "status_pending",
    });
    assert.equal(attempts, 1);
    assert.deepEqual(f.calls.slice(0, 2), ["quiesce", "checkpoint"]);
    f.setPower("off");
    await f.life.power(f.id, "shutdown");
    assert.equal(f.store.get(f.id).pending, null);
  }
});

test("historical guest shutdown receipts only observe; no fresh provider Stop is authorized", async (t) => {
  for (const state of ["unattempted", "unknown", "acknowledged"]) {
    const f = await fixture(t);
    await f.store.update(f.id, (r) => ({
      ...r,
      pending: {
        kind: "shutdown",
        operation: randomUUID(),
        serverId: "vm",
        attempted: state !== "unattempted",
        acknowledged: state === "acknowledged",
      },
    }));
    await assert.rejects(f.life.power(f.id, "shutdown"));
    assert.deepEqual(f.calls, []);
    assert.ok(f.store.get(f.id).pending);
    f.setPower("off");
    await f.life.power(f.id, "shutdown");
    assert.equal(f.store.get(f.id).pending, null);
  }
});

test("Stop is idempotent when OFF and stale target receipts cannot settle or submit", async (t) => {
  const f = await fixture(t);
  f.setPower("off");
  await f.life.power(f.id, "shutdown");
  assert.deepEqual(f.calls, []);
  await f.store.update(f.id, (r) => ({
    ...r,
    pending: {
      kind: "shutdown",
      serverId: "other",
      attempted: false,
      providerOperation: "halt",
    },
  }));
  await assert.rejects(f.life.power(f.id, "shutdown"), {
    code: "stale_server",
  });
  assert.equal(f.store.get(f.id).pending.serverId, "other");
  assert.deepEqual(f.calls, []);
});

test("Stop rechecks exact ownership and blocks after quiesce before any provider mutation", async (t) => {
  for (const problem of ["owner", "blocks", "target"]) {
    const f = await fixture(t),
      get = f.api.getServer,
      checkpoint = f.remote.checkpoint;
    f.remote.checkpoint = async () => {
      const cp = await checkpoint();
      f.api.getServer = async () => ({
        ...(await get()),
        ...(problem === "owner"
          ? { tags: [] }
          : problem === "blocks"
            ? { volumes: ["block"] }
            : { id: "other" }),
      });
      return cp;
    };
    await assert.rejects(f.life.power(f.id, "shutdown"), {
      code: problem === "blocks" ? "volumes_unsupported" : "ownership_mismatch",
    });
    assert.deepEqual(f.calls, ["quiesce", "checkpoint"]);
    assert.equal(f.store.get(f.id).pending.attempted, false);
  }
});

test("quiesce, checkpoint or clone-cache failure cannot reach provider Stop", async (t) => {
  for (const hook of ["quiesce", "checkpoint", "prepareSnapshot"]) {
    const f = await fixture(t);
    f.remote[hook] = async () => {
      throw Error("hook failed");
    };
    await assert.rejects(
      hook === "prepareSnapshot"
        ? f.life.hibernate(f.id)
        : f.life.power(f.id, "shutdown"),
      /hook failed/,
    );
    assert.equal(
      f.calls.some((c) => c.method),
      false,
    );
    assert.equal(f.store.get(f.id).pending, undefined);
  }
});

test("Hibernate cannot snapshot before fresh OFF and never repeats an uncertain or acknowledged Stop", async (t) => {
  for (const acknowledged of [false, true]) {
    const f = await fixture(t),
      request = f.api.request,
      waitStatus = f.api.waitStatus;
    let stops = 0;
    f.api.request = async (...args) => {
      if (!args[1].endsWith("/halt")) return request(...args);
      stops++;
      if (!acknowledged)
        throw Object.assign(Error("Stop response lost"), {
          code: "outcome_unknown",
        });
      await request(...args);
      f.setPower("running");
      return {};
    };
    f.api.waitStatus = async () => {
      throw Object.assign(Error("OFF not observed"), {
        code: "status_pending",
      });
    };
    await assert.rejects(f.life.hibernate(f.id), {
      code: acknowledged ? "status_pending" : "outcome_unknown",
    });
    await assert.rejects(f.life.hibernate(f.id), {
      code: acknowledged ? "status_pending" : "outcome_unknown",
    });
    assert.equal(stops, 1);
    assert.equal(
      f.calls.some((c) => c.url === "/snapshots"),
      false,
    );
    assert.equal(f.store.get(f.id).snapshot.imageId, "old");
    assert.equal(f.store.get(f.id).hibernate.stage, "shutdown");
    f.setPower("off");
    f.api.waitStatus = waitStatus;
    await f.life.hibernate(f.id);
    assert.equal(stops, 1);
    assert.equal(f.calls.filter((c) => c.url === "/snapshots").length, 1);
    assert.equal(f.store.get(f.id).hibernate.stage, "release");
  }
});

test("explicit retry after definitive Stop rejection must pass fresh ownership and block checks", async (t) => {
  const f = await fixture(t),
    get = f.api.getServer;
  let attempts = 0;
  f.api.request = async () => {
    attempts++;
    throw Object.assign(Error("rejected"), {
      code: "provider_rejected",
      httpStatus: 429,
    });
  };
  await assert.rejects(f.life.power(f.id, "shutdown"), {
    code: "provider_rejected",
  });
  assert.equal(f.store.get(f.id).pending, null);
  assert.equal(f.store.get(f.id).lastRejectedOperation.kind, "shutdown");
  f.api.getServer = async () => ({ ...(await get()), volumes: ["block"] });
  await assert.rejects(f.life.power(f.id, "shutdown"), {
    code: "volumes_unsupported",
  });
  f.api.getServer = async () => ({ ...(await get()), tags: [] });
  await assert.rejects(f.life.power(f.id, "shutdown"), {
    code: "ownership_mismatch",
  });
  assert.equal(attempts, 1);
});
