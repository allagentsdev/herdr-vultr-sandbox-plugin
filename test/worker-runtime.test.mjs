import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/state.mjs";
import { runWorker } from "../src/pane.mjs";
import { temporary } from "./helpers.mjs";
import { requestWorker } from "../src/control.mjs";
test("transport return preserves owner pane and worker, queues reconnect, and never restarts or powers off the agent", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID();
  await store.create({
    id,
    namespace: "test",
    localRoot: temporary(t),
    vm: { serverId: 12, hostKey: "pin", initialized: true },
    phase: "ready",
    config: {
      adapter: { launch: "agent", resume: "agent resume", authCheck: "true" },
    },
  });
  let attaches = 0;
  const outputs = [];
  const remote = {
    auth: () => {},
    ensureWorker: () => {},
    attach: async () => {
      attaches++;
      assert.equal(
        (await requestWorker(store, id, "reconnect")).status,
        "busy",
      );
      return { code: 255 };
    },
    inspectSession: () => ({ status: "detached", paneId: "%0", pid: 123 }),
  };
  const life = { owned: async () => ({ powerState: "running" }) };
  let count = 0;
  await runWorker({
    store,
    id,
    initialAction: "reconnect",
    services: { remote, life },
    resolvePane: () => "w1:p5",
    registerSession: () => true,
    menuInput: async () => (count++ === 0 ? "reconnect" : "q"),
    display: (s) => outputs.push(s),
  });
  assert.equal(attaches, 2);
  assert.equal(store.get(id).vm.serverId, 12);
  assert.equal(store.get(id).workerPane, null);
  assert.equal(store.get(id).transport.state, "detached");
  assert.ok(outputs.some((s) => s.includes("Compute power is not inferred")));
  assert.equal(await requestWorker(store, id), null);
});

test("Recover finalizes an already authorized lost hibernate delete and never releases an unapproved checkpoint", async (t) => {
  const { Lifecycle } = await import("../src/lifecycle.mjs");
  for (const approved of [false, true]) {
    const store = new Store(temporary(t)),
      id = randomUUID(),
      confirmation = "DELETE 42 SNAPSHOT 7";
    const checkpoint = {
      workerId: id,
      sourceDigest: "a".repeat(64),
      currentSourceDigest: "b".repeat(64),
      at: "2026-11-18T00:00:00.000Z",
    };
    await store.create({
      id,
      namespace: "test",
      localRoot: temporary(t),
      phase: "release-approval",
      vm: { serverId: 42, architecture: "x86" },
      snapshot: { imageId: 7, description: "saved", checkpoint },
      hibernate: { stage: "release", checkpoint },
      pending: approved
        ? { kind: "delete", serverId: 42, confirmation, attempted: true }
        : null,
      config: { osId: 2284 },
    });
    let confirmations = 0;
    const api = {
      getServer: async () =>
        approved
          ? null
          : {
              id: 42,
              powerState: "off",
              tags: ["herdr-plugin=vultr.sandbox", `herdr-worker=${id}`],
            },
      getImage: async () => ({
        id: 7,
        status: "complete",
        os_id: 2284,
        size: 123,
        description: "saved",
      }),
      waitStatus: async (serverId, status) => {
        assert.equal(serverId, 42);
        assert.equal(status, "deleted");
        confirmations++;
      },
      request: () =>
        assert.fail("Recovery must not send another DELETE/create"),
    };
    const life = new Lifecycle(store, api, {});
    await runWorker({
      store,
      id,
      initialAction: "recover",
      services: { life },
      resolvePane: () => "w1:p5",
      menuInput: async () => "q",
      display: () => {},
    });
    const r = store.get(id);
    assert.equal(r.snapshot.imageId, 7);
    assert.equal(r.id, id);
    assert.equal(confirmations, approved ? 1 : 0);
    assert.equal(r.vm?.serverId ?? null, approved ? null : 42);
    assert.equal(r.phase, approved ? "hibernated" : "release-approval");
    assert.equal(r.pending, null);
  }
});

test("queued failures and cancelled approvals have correlated queryable receipts", async (t) => {
  const { PluginError } = await import("../src/result.mjs");
  const { workerInfo } = await import("../src/mappings.mjs");
  for (const action of ["reconnect", "restart-agent"]) {
    const store = new Store(temporary(t)),
      id = randomUUID();
    await store.create({
      id,
      namespace: "test",
      localRoot: temporary(t),
      vm: { serverId: "vm", hostKey: "pin", initialized: true },
      phase: "ready",
      config: {
        adapter: { launch: "agent", resume: "agent resume", authCheck: "true" },
      },
    });
    let submitted = false,
      receipt;
    const life = { owned: async () => ({ powerState: "running" }) },
      remote = {
        auth: () => {
          throw new PluginError(
            "auth_required",
            "private output must not be stored",
          );
        },
      };
    await runWorker({
      store,
      id,
      services: { life, remote },
      resolvePane: () => "w1:p2",
      display: () => {},
      askInput: async () => "DECLINE",
      menuInput: async () => {
        if (submitted) return "q";
        submitted = true;
        receipt = await requestWorker(store, id, action);
        return "";
      },
    });
    assert.equal(receipt.status, "queued");
    assert.ok(receipt.requestId);
    const saved = workerInfo(store.get(id)).controlRequests.find(
      (r) => r.requestId === receipt.requestId,
    );
    assert.equal(saved.action, action);
    assert.equal(saved.status, action === "reconnect" ? "failed" : "cancelled");
    assert.equal(
      saved.code,
      action === "reconnect" ? "auth_required" : "approval_declined",
    );
    assert.equal(JSON.stringify(saved).includes("private output"), false);
  }
});

test("a new dashboard marks an abandoned queued request interrupted without replay", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID(),
    requestId = randomUUID();
  await store.create({
    id,
    namespace: "test",
    localRoot: temporary(t),
    phase: "ready",
    config: {},
    controlRequests: [{ requestId, action: "stop", status: "queued" }],
  });
  await runWorker({
    store,
    id,
    services: {},
    resolvePane: () => "w1:p2",
    display: () => {},
    menuInput: async () => "q",
  });
  const receipt = store.get(id).controlRequests[0];
  assert.equal(receipt.requestId, requestId);
  assert.equal(receipt.status, "interrupted");
  assert.equal(receipt.code, "previous_owner_lost");
});

test("a rejected acceptance write cannot queue an action and releases the acceptance slot", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID();
  await store.create({
    id,
    namespace: "test",
    localRoot: temporary(t),
    phase: "ready",
    config: {},
  });
  const update = store.update.bind(store);
  let reject = true,
    first,
    second,
    menus = 0;
  store.update = (worker, fn) =>
    update(worker, (r) => {
      const next = fn(r);
      if (reject && next.controlRequests?.some((x) => x.status === "queued")) {
        reject = false;
        throw Error("disk full");
      }
      return next;
    });
  await runWorker({
    store,
    id,
    services: {
      life: {
        status: async () => ({ providerStatus: "off" }),
        power: () => assert.fail("Rejected action ran"),
      },
    },
    resolvePane: () => "w1:p2",
    display: () => {},
    menuInput: async () => {
      if (menus++) return "q";
      first = await requestWorker(store, id, "stop");
      second = await requestWorker(store, id, "status");
      return "";
    },
  });
  assert.equal(first.status, "invalid_request");
  assert.equal(second.status, "queued");
  assert.equal(store.get(id).controlRequests.length, 1);
  assert.equal(store.get(id).controlRequests[0].requestId, second.requestId);
  assert.equal(store.get(id).controlRequests[0].status, "completed");
});

test("closing a dashboard drains acceptance after client timeout before releasing ownership", async (t) => {
  const { hasLiveOwner } = await import("../src/control.mjs");
  const store = new Store(temporary(t)),
    id = randomUUID();
  await store.create({
    id,
    namespace: "test",
    localRoot: temporary(t),
    phase: "ready",
    config: {},
  });
  const update = store.update.bind(store);
  let enter, release, reply;
  const entered = new Promise((resolve) => (enter = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  store.update = async (worker, fn) => {
    const next = fn(store.get(worker));
    if (next.controlRequests?.some((x) => x.status === "queued")) {
      enter();
      await gate;
    }
    return update(worker, fn);
  };
  const worker = runWorker({
    store,
    id,
    services: {
      life: {
        power: () => assert.fail("Closing owner replayed queued action"),
      },
    },
    resolvePane: () => "w1:p2",
    display: () => {},
    menuInput: async () => {
      reply = requestWorker(store, id, "stop", { timeout: 30 });
      await entered;
      return "q";
    },
  });
  await entered;
  assert.equal(await reply, null);
  const retained = hasLiveOwner(store, id);
  release();
  await worker;
  assert.equal(retained, true);
  assert.equal(hasLiveOwner(store, id), false);
  assert.equal(store.get(id).controlRequests[0].status, "interrupted");
});

test("queued login and attach failures never claim completed receipts", async (t) => {
  for (const action of ["login", "reconnect"]) {
    const store = new Store(temporary(t)),
      id = randomUUID();
    await store.create({
      id,
      namespace: "test",
      localRoot: temporary(t),
      phase: "ready",
      vm: { serverId: "vm", hostKey: "pin", initialized: true },
      config: {
        adapter: { launch: "agent", resume: "agent resume", authCheck: "true" },
      },
    });
    let menus = 0,
      receipt;
    const remote = {
      auth: () => {},
      ensureWorker: () => {},
      login: async () => ({ code: 1 }),
      attach: async () => ({ code: 255 }),
      inspectSession: () => ({ status: "unavailable" }),
    };
    await runWorker({
      store,
      id,
      services: {
        life: { owned: async () => ({ powerState: "running" }) },
        remote,
      },
      resolvePane: () => "w1:p2",
      registerSession: () => true,
      display: () => {},
      menuInput: async () => {
        if (menus++) return "q";
        receipt = await requestWorker(store, id, action);
        return "";
      },
    });
    const saved = store
      .get(id)
      .controlRequests.find((x) => x.requestId === receipt.requestId);
    assert.equal(saved.status, "failed");
    assert.equal(
      saved.code,
      action === "login" ? "login_failed" : "transport_failed",
    );
  }
});
