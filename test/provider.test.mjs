import test from "node:test";
import assert from "node:assert/strict";
import { Cloud } from "../src/provider.mjs";
const response = (data, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(data), { status });
test("Vultr uses authenticated v2, cursor pagination and exact tags without following server URLs", async () => {
  const requests = [];
  const api = new Cloud("management-secret", {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return response({
        instances: [
          {
            id: String(requests.length),
            tags: [
              "herdr-plugin=vultr.sandbox",
              "herdr-worker=w",
              "herdr-operation=o",
            ],
          },
        ],
        meta: { links: { next: requests.length === 1 ? "cursor+/=" : "" } },
      });
    },
  });
  const found = await api.find("instances", {
    "herdr-plugin": "vultr.sandbox",
    "herdr-worker": "w",
    "herdr-operation": "o",
  });
  assert.deepEqual(
    found.map((x) => x.id),
    ["1", "2"],
  );
  assert.match(
    requests[0].url,
    /^https:\/\/api.vultr.com\/v2\/instances\?per_page=100$/,
  );
  assert.match(requests[1].url, /cursor=cursor%2B%2F%3D$/);
  assert.equal(
    requests[0].options.headers.Authorization,
    "Bearer management-secret",
  );
  assert.equal(requests[0].options.redirect, "error");
});
test("instance power readiness and attached blocks use separate actual fields", async () => {
  const api = new Cloud("secret", {
    interval: 0,
    fetch: async (url) =>
      url.includes("/blocks")
        ? response({
            blocks: [{ id: "block", attached_to_instance: "vm" }],
            meta: { links: {} },
          })
        : response({
            instance: {
              id: "vm",
              status: "active",
              server_status: "ok",
              power_status: "running",
              main_ip: "192.0.2.1",
            },
          }),
  });
  const vm = await api.getServer("vm");
  assert.equal(vm.powerState, "running");
  assert.deepEqual(vm.volumes, ["block"]);
  assert.equal((await api.waitStatus("vm", "running")).main_ip, "192.0.2.1");
});
test("snapshot polls complete rather than Hetzner actions and refuses failed snapshots", async () => {
  let n = 0;
  const api = new Cloud("secret", {
    interval: 0,
    attempts: 2,
    fetch: async () =>
      response({
        snapshot: {
          id: "snap",
          status: ++n === 1 ? "pending" : "complete",
          size: 123,
          os_id: 2284,
        },
      }),
  });
  assert.equal((await api.waitSnapshot("snap")).status, "complete");
  await assert.rejects(
    new Cloud("secret", {
      interval: 0,
      attempts: 1,
      fetch: async () =>
        response({ snapshot: { id: "snap", status: "pending" } }),
    }).waitSnapshot("snap"),
    { code: "snapshot_pending" },
  );
});
test("HTTP and transport unknown outcomes redact bodies, mutation 404 is not success", async () => {
  for (const [fetcher, code] of [
    [async () => response({ secret: "do-not-log" }, 401), "provider_rejected"],
    [async () => response({}, 503), "outcome_unknown"],
    [
      async () => {
        throw Error("do-not-log");
      },
      "outcome_unknown",
    ],
    [async () => response({}, 404), "provider_rejected"],
  ]) {
    await assert.rejects(
      new Cloud("secret", { fetch: fetcher }).request("POST", "/instances", {}),
      (e) => e.code === code && !e.message.includes("do-not-log"),
    );
  }
  assert.equal(
    await new Cloud("s", { fetch: async () => response({}, 404) }).getImage(
      "missing",
    ),
    null,
  );
});
test("malformed inventory and repeated cursor fail closed", async () => {
  await assert.rejects(
    new Cloud("s", { fetch: async () => response({}) }).find("instances", {}),
    { code: "provider_invalid" },
  );
  await assert.rejects(
    new Cloud("s", {
      fetch: async () =>
        response({ instances: [], meta: { links: { next: "same" } } }),
    }).find("instances", {}),
    { code: "provider_invalid" },
  );
});
