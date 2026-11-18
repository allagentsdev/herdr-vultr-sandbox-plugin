import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/state.mjs";
import { Lifecycle } from "../../src/lifecycle.mjs";
import { temporary } from "../helpers.mjs";
export async function idleWorker(t) {
  const store = new Store(temporary(t)),
    id = randomUUID(),
    calls = [];
  const serverId = randomUUID(),
    imageId = randomUUID(),
    oldImageId = randomUUID();
  await store.create({
    id,
    namespace: "test",
    localRoot: temporary(t),
    config: { plan: "vc2-2c-4gb", region: "syd", osId: 2284, adapter: {} },
    phase: "ready",
    vm: {
      serverId,
      plan: "vc2-2c-4gb",
      disk: 80,
      initialized: true,
      hostKey: "pin",
    },
    snapshot: { imageId: oldImageId },
  });
  const f = {
    store,
    id,
    calls,
    serverId,
    imageId,
    oldImageId,
    now: Date.now(),
    activity: { state: "idle", token: "turn-1" },
    digest: "b".repeat(64),
  };
  let server = {
      id: serverId,
      powerState: "running",
      volumes: [],
      tags: ["herdr-plugin=vultr.sandbox", `herdr-worker=${id}`],
      main_ip: "192.0.2.1",
      plan: "vc2-2c-4gb",
      disk: 80,
    },
    image;
  f.api = {
    getServer: async () => server,
    getImage: async () => image,
    waitSnapshot: async () => image,
    find: async (kind, query) =>
      kind === "snapshots" && image?.description === query.description
        ? [image]
        : kind === "instances" &&
            server &&
            Object.entries(query).every(([key, value]) =>
              server.tags.includes(`${key}=${value}`),
            )
          ? [server]
          : [],
    waitStatus: async (_, state) => {
      assert.equal(server?.powerState ?? "deleted", state);
      return server;
    },
    async request(method, url, body) {
      calls.push([method, url, body]);
      if (url.endsWith("/halt")) {
        assert.equal(body, undefined);
        server.powerState = "off";
      }
      if (url.endsWith("/start")) {
        assert.equal(body, undefined);
        server.powerState = "running";
      }
      if (method === "DELETE") server = null;
      if (url === "/snapshots") {
        image = {
          id: imageId,
          status: "complete",
          os_id: 2284,
          size: 123,
          description: body.description,
        };
        return { snapshot: image };
      }
      if (url === "/instances") {
        server = {
          id: randomUUID(),
          powerState: "running",
          volumes: [],
          tags: body.tags,
          main_ip: "192.0.2.2",
          plan: body.plan,
          disk: 80,
        };
        return { instance: server };
      }
      return {};
    },
  };
  f.setServer = (value) => {
    server = value;
  };
  f.remote = {
    activity: async () => f.activity,
    quiesce: async () => calls.push("quiesce"),
    checkpoint: async () => ({
      workerId: id,
      sourceDigest: "a".repeat(64),
      currentSourceDigest: f.digest,
      at: new Date(f.now).toISOString(),
    }),
    prepareSnapshot: async () => calls.push("prepareSnapshot"),
    waitReady: async () => {},
    activate: async () => {},
    auth: async () => {},
    ensureWorker: async () => {},
  };
  f.life = new Lifecycle(store, f.api, f.remote);
  f.life.hostIdentities = {
    prepare: () => ({ publicKey: "ssh-ed25519 AAAA" }),
    cloudConfig: () => "public fixture",
  };
  f.poll = () => f.life.expire(id, store.get(id).expiry.session.id, f.now);
  f.tick = async (minutes) => {
    for (let i = 0; i < minutes; i++) {
      f.now += 60000;
      await f.poll();
    }
  };
  await f.life.configureExpiry(id, 15, `AUTO-HIBERNATE ${id}`);
  return f;
}
