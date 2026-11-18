import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/state.mjs";
import { Connections } from "../src/connections.mjs";
import { idleWorker as fixture } from "./fixtures/idle-worker.mjs";
import { Lifecycle } from "../src/lifecycle.mjs";
import { temporary } from "./helpers.mjs";

test("approved idle policy requires controller readiness before any create mutation", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID(),
    calls = [];
  await store.create({
    id,
    namespace: "test",
    localRoot: temporary(t),
    config: { plan: "vc2-2c-4gb", region: "syd", osId: 2284 },
    expiry: {
      mode: "idle",
      minutes: 15,
      approvedAt: new Date().toISOString(),
      session: null,
    },
  });
  let server;
  const api = {
    find: async () => [],
    getServer: async () => server,
    waitStatus: async () => server,
    request: async (method, url, body) => {
      calls.push({ method, url });
      server = {
        id: randomUUID(),
        tags: body.tags,
        powerState: "running",
        volumes: [],
        plan: body.plan,
        disk: 80,
        main_ip: "192.0.2.1",
      };
      return { instance: server };
    },
  };
  const life = new Lifecycle(
    store,
    api,
    {},
    {
      ensureController: async () => {
        throw Object.assign(Error("offline"), {
          code: "controller_unavailable",
        });
      },
    },
  );
  life.hostIdentities = {
    prepare: () => ({ publicKey: "ssh-ed25519 AAAA" }),
    cloudConfig: () => "public fixture",
  };
  await assert.rejects(life.create(id, "ssh-ed25519 AAAA"), {
    code: "controller_unavailable",
  });
  assert.deepEqual(calls, []);
  assert.equal(store.get(id).vm, undefined);
});

test("only continuously confirmed idle expires; working, blocked, unknown, activity changes and observation gaps reset idle", async (t) => {
  const f = await fixture(t);
  for (const state of ["working", "blocked", "unknown"]) {
    f.activity = { state };
    await f.tick(20);
    assert.equal(f.store.get(f.id).vm.serverId, f.serverId);
    assert.equal(f.store.get(f.id).expiry.session.expiresAt, null);
  }
  f.activity = { state: "idle", token: "turn-1" };
  await f.poll();
  await f.tick(14);
  f.activity = { state: "idle", token: "turn-2" };
  await f.poll();
  await f.tick(14);
  assert.equal(f.calls.length, 0);
  f.now += 120000;
  await f.poll();
  await f.tick(14);
  assert.equal(f.calls.length, 0);
  await f.tick(1);
  assert.equal(f.store.get(f.id).vm, null);
  assert.equal(f.store.get(f.id).snapshot.imageId, f.imageId);
});
test("activity is rechecked immediately before automatic quiesce", async (t) => {
  const f = await fixture(t);
  await f.poll();
  await f.tick(14);
  let checks = 0;
  f.remote.activity = async () =>
    ++checks === 1 ? { state: "idle", token: "turn-1" } : { state: "working" };
  await f.tick(1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.get(f.id).expiry.session.activityState, "working");
});

test("an idle token change at the final recheck restarts the idle window without quiesce or release", async (t) => {
  const f = await fixture(t);
  await f.poll();
  await f.tick(14);
  let checks = 0;
  f.remote.activity = async () => ({
    state: "idle",
    token: ++checks === 1 ? "turn-1" : "turn-2",
  });
  await f.tick(1);
  const session = f.store.get(f.id).expiry.session;
  assert.equal(session.activityState, "idle");
  assert.equal(session.activityToken, "turn-2");
  assert.equal(session.idleSince, new Date(f.now).toISOString());
  assert.equal(session.expiresAt, new Date(f.now + 15 * 60000).toISOString());
  assert.equal(session.releaseAuthorized, false);
  assert.equal(f.store.get(f.id).vm.serverId, f.serverId);
  assert.deepEqual(f.calls, []);
  await f.tick(14);
  assert.deepEqual(f.calls, []);
  await f.tick(1);
  assert.equal(f.store.get(f.id).vm, null);
});

test("a reversed observation clock restarts confirmed idle instead of retaining the previous window", async (t) => {
  const f = await fixture(t);
  await f.poll();
  await f.tick(10);
  const previous = f.store.get(f.id).expiry.session;
  f.now -= 60000;
  await f.poll();
  const reset = f.store.get(f.id).expiry.session;
  assert.notEqual(reset.idleSince, previous.idleSince);
  assert.equal(reset.idleSince, new Date(f.now).toISOString());
  assert.equal(reset.lastObservedAt, reset.idleSince);
  assert.equal(reset.expiresAt, new Date(f.now + 15 * 60000).toISOString());
  assert.deepEqual(f.calls, []);
});

test("exactly 90 seconds preserves continuous idle while 90 seconds plus one millisecond resets it", async (t) => {
  for (const gap of [90000, 90001]) {
    const f = await fixture(t);
    await f.poll();
    await f.tick(10);
    const previous = f.store.get(f.id).expiry.session;
    f.now += gap;
    await f.poll();
    const current = f.store.get(f.id).expiry.session;
    assert.equal(
      current.idleSince,
      gap === 90000 ? previous.idleSince : new Date(f.now).toISOString(),
    );
    assert.equal(
      current.expiresAt,
      gap === 90000
        ? previous.expiresAt
        : new Date(f.now + 15 * 60000).toISOString(),
    );
    assert.deepEqual(f.calls, []);
  }
});
test("restart cannot count an unobserved offline interval as idle", async (t) => {
  const f = await fixture(t);
  await f.poll();
  await f.tick(10);
  f.life = new Lifecycle(new Store(f.store.directory), f.api, f.remote);
  f.now += 3600000;
  await f.poll();
  assert.equal(f.calls.length, 0);
  await f.tick(14);
  assert.equal(f.calls.length, 0);
  await f.tick(1);
  assert.equal(f.store.get(f.id).vm, null);
});
test("lost power-on response reconciles without a second power-on or reusing an old checkpoint", async (t) => {
  const f = await fixture(t);
  await f.life.power(f.id, "shutdown");
  const request = f.api.request;
  f.api.request = async (method, url, body) => {
    const result = await request(method, url, body);
    if (url.endsWith("/start"))
      throw Object.assign(Error("lost"), { code: "outcome_unknown" });
    return result;
  };
  await assert.rejects(f.life.power(f.id, "poweron"), {
    code: "outcome_unknown",
  });
  const session = f.store.get(f.id).expiry.session.id;
  f.digest = "c".repeat(64);
  f.life = new Lifecycle(new Store(f.store.directory), f.api, f.remote);
  await f.poll();
  await f.tick(15);
  assert.equal(f.store.get(f.id).vm, null);
  assert.equal(
    f.store.get(f.id).snapshot.checkpoint.currentSourceDigest,
    f.digest,
  );
  assert.equal(f.calls.filter((c) => c[1]?.endsWith("/start")).length, 1);
  assert.equal(f.calls.filter((c) => c === "quiesce").length, 2);
  assert.equal(f.store.get(f.id).expiry.session.id, session);
});
test("Hibernate then failed Resume after source changes cannot authorize later Stop with stale checkpoint", async (t) => {
  const f = await fixture(t);
  await f.life.hibernate(f.id);
  f.remote.activate = async () => {
    f.digest = "d".repeat(64);
    throw Error("restart failed after writer started");
  };
  await assert.rejects(
    new Connections(f.store, f.life, f.remote).prepare(f.id, "resume"),
  );
  assert.equal(f.store.get(f.id).hibernate, null);
  await f.life.power(f.id, "shutdown");
  await f.poll();
  await f.tick(15);
  assert.equal(f.store.get(f.id).vm, null);
  assert.equal(
    f.store.get(f.id).snapshot.checkpoint.currentSourceDigest,
    f.digest,
  );
  assert.equal(f.calls.filter((c) => c === "quiesce").length, 2);
});
test("controller readiness is required before new consent, create or power-on provider mutations", async (t) => {
  const f = await fixture(t),
    unavailable = async () => {
      throw Object.assign(Error("offline"), { code: "controller_unavailable" });
    };
  const life = new Lifecycle(f.store, f.api, f.remote, {
    ensureController: unavailable,
  });
  await f.life.power(f.id, "shutdown");
  f.calls.length = 0;
  await assert.rejects(life.power(f.id, "poweron"), {
    code: "controller_unavailable",
  });
  assert.equal(f.calls.length, 0);
  await f.store.update(f.id, (r) => ({
    ...r,
    vm: null,
    hibernate: null,
    expiry: null,
  }));
  await assert.rejects(
    life.configureExpiry(f.id, 15, `AUTO-HIBERNATE ${f.id}`),
    { code: "controller_unavailable" },
  );
  assert.equal(f.store.get(f.id).expiry, null);
  await f.store.update(f.id, (r) => ({
    ...r,
    expiry: {
      mode: "idle",
      minutes: 15,
      approvedAt: new Date().toISOString(),
      session: null,
    },
  }));
  await assert.rejects(life.create(f.id, "ssh-ed25519 AAAA"), {
    code: "controller_unavailable",
  });
  assert.equal(f.calls.length, 0);
});

test("same-VM Resume starts fresh unknown activity before power-on; reconnect preserves idle evidence", async (t) => {
  const f = await fixture(t);
  await f.poll();
  const old = f.store.get(f.id).expiry.session;
  await f.life.power(f.id, "shutdown");
  const request = f.api.request;
  f.api.request = async (method, url, body) => {
    if (url.endsWith("/start")) {
      const session = f.store.get(f.id).expiry.session;
      assert.notEqual(session.id, old.id);
      assert.equal(session.expiresAt, null);
      assert.equal(f.store.get(f.id).hibernate, null);
    }
    return request(method, url, body);
  };
  const connections = new Connections(f.store, f.life, f.remote);
  await connections.prepare(f.id, "resume");
  await f.poll();
  const current = f.store.get(f.id).expiry.session;
  await connections.prepare(f.id, "reconnect");
  assert.deepEqual(f.store.get(f.id).expiry.session, current);
  await f.life.expire(f.id, old.id, f.now + 1e9);
  assert.equal(f.store.get(f.id).vm.serverId, f.serverId);
  assert.deepEqual(f.store.get(f.id).expiry.session, current);
});

test("explicit Resume of a running instance renews an overdue session before activation without Start; pending recovery preserves that session", async (t) => {
  const f = await fixture(t);
  await f.poll();
  await f.store.update(f.id, (r) => ({
    ...r,
    expiry: {
      ...r.expiry,
      session: { ...r.expiry.session, expiresAt: new Date(0).toISOString() },
    },
  }));
  const old = f.store.get(f.id).expiry.session;
  f.remote.activate = async () => {
    const session = f.store.get(f.id).expiry.session;
    assert.notEqual(session.id, old.id);
    assert.equal(session.serverId, f.serverId);
    assert.equal(session.activityState, "unknown");
    assert.equal(session.expiresAt, null);
    assert.equal(session.lastObservedAt, null);
  };
  const connections = new Connections(f.store, f.life, f.remote);
  await connections.prepare(f.id, "resume");
  const fresh = f.store.get(f.id).expiry.session;
  assert.equal(f.calls.length, 0);
  await connections.prepare(f.id, "reconnect");
  assert.deepEqual(f.store.get(f.id).expiry.session, fresh);
  await f.life.expire(f.id, old.id, f.now + 1e9);
  assert.deepEqual(f.store.get(f.id).expiry.session, fresh);
  await f.store.update(f.id, (r) => ({
    ...r,
    pending: {
      kind: "poweron",
      operation: randomUUID(),
      serverId: f.serverId,
      attempted: true,
    },
  }));
  await connections.prepare(f.id, "resume");
  assert.deepEqual(f.store.get(f.id).expiry.session, fresh);
  assert.equal(f.store.get(f.id).pending, null);
  assert.equal(f.calls.length, 0);
});
