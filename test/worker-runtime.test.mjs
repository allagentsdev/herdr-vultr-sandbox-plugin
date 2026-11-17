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
