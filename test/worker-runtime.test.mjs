import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/state.mjs";
import { runWorker } from "../src/pane.mjs";
import { temporary } from "./helpers.mjs";
import { requestWorker } from "../src/control.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { repository, write } from "./helpers.mjs";
import { validateConfig } from "../src/config.mjs";
import { captureSnapshot } from "../src/manifest.mjs";
import path from "node:path";

test("source review discloses recurring exact-worker idle release and saves consent before create; explicit off stays off", async (t) => {
  for (const idleTimeoutMinutes of [0, 15]) {
    const store = new Store(temporary(t)),
      id = randomUUID(),
      localRoot = repository(t),
      output = [];
    write(localRoot, "source.txt", "review these bytes\n");
    await store.create({
      id,
      namespace: "fixture",
      localRoot,
      config: validateConfig({ idleTimeoutMinutes }),
      vm: { serverId: randomUUID(), hostKey: "pin" },
    });
    let creates = 0;
    await runWorker({
      store,
      id,
      initialAction: "start-agent",
      services: {
        life: {
          create: async () => {
            creates++;
            const r = store.get(id);
            assert.ok(r.uploadApproval.digest);
            if (idleTimeoutMinutes) {
              assert.equal(r.expiry.minutes, 15);
              assert.equal(r.expiry.mode, "idle");
              assert.ok(r.expiry.approvedAt);
              assert.equal(r.expiry.session, null);
            } else assert.equal(r.expiry, null);
            throw Object.assign(Error("fixture stops before allocation"), {
              code: "fixture_stop",
            });
          },
        },
      },
      askInput: async (prompt) =>
        `UPLOAD ${prompt.match(/UPLOAD ([a-f0-9]{64})/)[1]}`,
      display: (line) => output.push(line),
      resolvePane: () => "fixture:p1",
      menuInput: async () => "q",
    });
    assert.equal(creates, 1);
    const review = output.find((line) => line.startsWith("Worker:"));
    assert.ok(review.includes(id));
    assert.ok(
      review.includes(
        idleTimeoutMinutes
          ? "15 minutes of confirmed inactivity"
          : "Automatic hibernation is disabled",
      ),
    );
    if (idleTimeoutMinutes) assert.ok(review.includes("host user service"));
  }
});

test("dashboard idle actions use fixed 15 minute policy and exact-worker enable/disable confirmations", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID(),
    calls = [];
  await store.create({
    id,
    namespace: "fixture",
    localRoot: temporary(t),
    config: {},
  });
  const menu = ["delay-hibernation", "disable-auto-hibernate", "q"];
  await runWorker({
    store,
    id,
    initialAction: "enable-auto-hibernate",
    services: {
      life: {
        configureExpiry: async (...args) => calls.push(["enable", ...args]),
        extendExpiry: async (...args) => calls.push(["delay", ...args]),
        disableExpiry: async (...args) => calls.push(["disable", ...args]),
      },
    },
    askInput: async (prompt) =>
      prompt.includes("DISABLE")
        ? `DISABLE AUTO-HIBERNATE ${id}`
        : `AUTO-HIBERNATE ${id}`,
    display: () => {},
    resolvePane: () => "fixture:p1",
    menuInput: async () => menu.shift(),
  });
  assert.deepEqual(calls, [
    ["enable", id, 15, `AUTO-HIBERNATE ${id}`],
    ["delay", id, 15],
    ["disable", id, `DISABLE AUTO-HIBERNATE ${id}`],
  ]);
});

test("an existing upload approval is reused without acquiring automatic-release consent", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID(),
    localRoot = repository(t),
    config = validateConfig();
  write(localRoot, "source.txt", "already reviewed\n");
  const snapshot = captureSnapshot(
    localRoot,
    config,
    path.join(store.artifacts(id), "baseline"),
  );
  await store.create({
    id,
    namespace: "fixture",
    localRoot,
    config,
    baseline: snapshot.directory,
    uploadApproval: { digest: snapshot.digest },
    vm: { serverId: randomUUID(), hostKey: "pin" },
  });
  let creates = 0;
  await runWorker({
    store,
    id,
    initialAction: "start-agent",
    services: {
      life: {
        create: async () => {
          creates++;
          assert.equal(store.get(id).expiry, undefined);
          throw Object.assign(Error("stop fixture before compute"), {
            code: "fixture_stop",
          });
        },
      },
    },
    askInput: async () => {
      assert.fail("existing source should not be reapproved");
    },
    display: () => {},
    resolvePane: () => "fixture:p1",
    menuInput: async () => "q",
  });
  assert.equal(creates, 1);
  assert.equal(store.get(id).expiry, undefined);
});

test("continuation metadata waits for the actual attached agent and records acceptance", async (t) => {
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
  let detected = false,
    acceptedWhileAttached = false;
  const remote = {
    auth: () => {},
    ensureWorker: () => {},
    attach: async () => {
      await delay(30);
      detected = true;
      for (let i = 0; i < 100; i++) {
        if (store.get(id).transport.sessionMetadata === true) {
          acceptedWhileAttached = true;
          break;
        }
        await delay(10);
      }
      detected = false;
      return { code: 0 };
    },
    inspectSession: () => ({ status: "detached" }),
  };
  await runWorker({
    store,
    id,
    initialAction: "reconnect",
    services: {
      remote,
      life: { owned: async () => ({ powerState: "running" }) },
    },
    resolvePane: () => "w1:p2",
    registerSession: () => detected,
    menuInput: async () => "q",
    display: () => {},
  });
  assert.equal(acceptedWhileAttached, true);
  assert.equal(store.get(id).transport.state, "detached");
  assert.equal(store.get(id).transport.sessionMetadata, undefined);
});

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

test("closing a dashboard drains real state-lock acceptance after client timeout before releasing ownership", async (t) => {
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
  let release,
    reportReply,
    reply,
    second,
    holding,
    entered = false,
    retained;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const received = new Promise((resolve) => {
    reportReply = resolve;
  });
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
      holding = store.withLock(
        id,
        async () => {
          entered = true;
          await gate;
        },
        { suffix: "state" },
      );
      while (!entered) await delay(1);
      const result = await requestWorker(store, id, "stop", { timeout: 30 });
      second = await requestWorker(store, id, "status");
      reportReply(result);
      return "q";
    },
  });
  try {
    reply = await received;
    await delay(10);
    retained = hasLiveOwner(store, id);
  } finally {
    release();
    await holding;
    await worker;
  }
  assert.equal(reply?.status, "outcome_unknown");
  assert.match(reply.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(second.status, "busy");
  assert.equal(retained, true);
  assert.equal(hasLiveOwner(store, id), false);
  const saved = store.get(id).controlRequests[0];
  assert.equal(saved.requestId, reply.requestId);
  assert.equal(saved.status, "interrupted");
  assert.equal(saved.code, "owner_closed");
});

test("public default-timeout action reconciles the same UUID through Info after delayed state-lock acceptance without replay", async (t) => {
  const { runAction } = await import("../src/actions.mjs");
  const { namespace } = await import("../src/state.mjs");
  const store = new Store(temporary(t)),
    id = randomUUID(),
    env = { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/synthetic/recovery" };
  await store.create({
    id,
    namespace: namespace(env),
    localRoot: temporary(t),
    phase: "ready",
    config: {},
  });
  const options = {
    store,
    env,
    context: { focused_pane_id: "w1:p1" },
    focusPane: () => {},
    openPane: () => assert.fail("Unknown submission cannot reopen a dashboard"),
  };
  const info = () => runAction("info", { worker: id }, options);
  let menus = 0,
    calls = 0,
    reply,
    elapsed,
    holdElapsed,
    missing,
    queued,
    completed,
    callsAtReply;
  await runWorker({
    store,
    id,
    env,
    resolvePane: () => "w1:p2",
    display: () => {},
    services: {
      life: {
        power: async () => {
          calls++;
        },
        status: async () => ({ powerState: "off" }),
      },
    },
    menuInput: async () => {
      if (menus++) {
        completed = await info();
        return "q";
      }
      let release,
        entered = false;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const holding = store.withLock(
        id,
        async () => {
          entered = true;
          await gate;
        },
        { suffix: "state" },
      );
      while (!entered) await delay(1);
      const started = performance.now();
      try {
        reply = await runAction("stop", { worker: id }, options);
        elapsed = performance.now() - started;
        callsAtReply = calls;
        missing = await info();
      } finally {
        while (performance.now() - started < 1750)
          await delay(Math.max(1, 1750 - (performance.now() - started)));
        holdElapsed = performance.now() - started;
        release();
        await holding;
      }
      for (let i = 0; i < 100 && !store.get(id).controlRequests.length; i++)
        await delay(5);
      queued = await info();
      return "";
    },
  });
  assert.equal(reply.status, "outcome_unknown");
  assert.match(reply.requestId, /^[0-9a-f-]{36}$/);
  assert.ok(elapsed >= 1400, `default timeout returned after ${elapsed}ms`);
  assert.ok(holdElapsed >= 1750, `state lock held for ${holdElapsed}ms`);
  t.diagnostic(
    `default timeout reply=${elapsed}ms; actual state lock hold=${holdElapsed}ms`,
  );
  assert.equal(callsAtReply, 0);
  assert.deepEqual(missing.controlRequests, []);
  assert.equal(
    queued.controlRequests.find((r) => r.requestId === reply.requestId)?.status,
    "queued",
  );
  assert.equal(
    completed.controlRequests.find((r) => r.requestId === reply.requestId)
      ?.status,
    "completed",
  );
  assert.equal(calls, 1);
});

test("queued reconnect preserves authentication command_timeout without Login or attach", async (t) => {
  const { Remote } = await import("../src/remote.mjs");
  const { PluginError } = await import("../src/result.mjs");
  const store = new Store(temporary(t)),
    id = randomUUID();
  await store.create({
    id,
    namespace: "test",
    localRoot: temporary(t),
    phase: "ready",
    vm: { serverId: "vm", hostKey: "pin", initialized: true },
    config: {
      adapter: {
        launch: "agent",
        resume: "agent resume",
        authCheck: "agent status",
      },
    },
  });
  let menus = 0,
    calls = 0,
    reply;
  const output = [],
    remote = new Remote({
      exec: () => {
        calls++;
        throw new PluginError(
          "command_timeout",
          "remote outcome remains uncertain",
        );
      },
      interactive: () =>
        assert.fail("Timeout cannot authorize Login or attach"),
    });
  await runWorker({
    store,
    id,
    resolvePane: () => "w1:p2",
    display: (text) => output.push(text),
    services: {
      life: { owned: async () => ({ powerState: "running" }) },
      remote,
    },
    menuInput: async () => {
      if (menus++) return "q";
      reply = await requestWorker(store, id, "reconnect");
      return "";
    },
  });
  const receipt = store
    .get(id)
    .controlRequests.find((r) => r.requestId === reply.requestId);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "command_timeout");
  assert.equal(calls, 1);
  assert.ok(
    output.some((text) => text.includes("remote outcome remains uncertain")),
  );
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
