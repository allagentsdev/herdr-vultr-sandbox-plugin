import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/state.mjs";
import { serveWorker, requestWorker } from "../src/control.mjs";
import { temporary } from "./helpers.mjs";
test("private worker owner survives transport work, rejects duplicate owner and can be reclaimed after exit", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID();
  let busy = true;
  const close = await serveWorker(store, id, (action) => ({
    status: action === "ping" ? "alive" : busy ? "attached" : "queued",
    paneId: "w1:p2",
  }));
  assert.equal(
    fs.statSync(path.join(store.artifacts(id), "control.sock")).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await requestWorker(store, id, "reconnect")).status,
    "attached",
  );
  await assert.rejects(
    serveWorker(store, id, () => ({})),
    { code: "worker_open" },
  );
  busy = false;
  assert.equal((await requestWorker(store, id, "reconnect")).status, "queued");
  await close();
  assert.equal(await requestWorker(store, id), null);
  const again = await serveWorker(store, id, () => ({ status: "alive" }));
  await again();
});

test("long host state paths use an owned short Unix socket on Linux and macOS", async (t) => {
  const directory = path.join(temporary(t), "x".repeat(90));
  const store = new Store(directory),
    id = randomUUID();
  const close = await serveWorker(store, id, () => ({ status: "alive" }));
  assert.equal((await requestWorker(store, id)).status, "alive");
  await close();
});

test("a synchronous busy owner retains its lease; only process exit permits reclaim and stale close cannot remove a successor", async (t) => {
  const { fork } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { hasLiveOwner } = await import("../src/control.mjs");
  const store = new Store(temporary(t)),
    id = randomUUID();
  const child = fork(
    fileURLToPath(new URL("./fixtures/control-owner.mjs", import.meta.url)),
    [store.directory, id],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(Error("Owner exited before ready: " + code)),
    );
  });
  assert.equal(await requestWorker(store, id, "ping", { timeout: 40 }), null);
  assert.equal(hasLiveOwner(store, id), true);
  await assert.rejects(
    serveWorker(store, id, () => ({ status: "replacement" })),
    { code: "worker_open" },
  );
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(hasLiveOwner(store, id), false);
  const close = await serveWorker(store, id, () => ({ status: "reclaimed" }));
  assert.equal((await requestWorker(store, id)).status, "reclaimed");
  await close();
  const successor = await serveWorker(store, id, () => ({
    status: "successor",
  }));
  await close();
  assert.equal((await requestWorker(store, id)).status, "successor");
  await successor();
});

test("lost and malformed owner replies preserve submitted request correlation", async (t) => {
  const net = await import("node:net");
  const replies = [
    "",
    '{"status":"partial"',
    "invalid\n",
    "x".repeat(8193),
    "null\n",
    "[]\n",
    "{}\n",
    '{"status":42}\n',
    "destroy",
  ];
  for (const [index, reply] of replies.entries())
    await t.test(String(index), async (t) => {
      const store = new Store(temporary(t)),
        id = randomUUID();
      let submitted;
      const server = net.createServer((socket) => {
        socket.on("data", (chunk) => {
          submitted = JSON.parse(String(chunk));
          if (reply === "destroy") socket.destroy();
          else socket.end(reply);
        });
      });
      await new Promise((resolve) =>
        server.listen(path.join(store.artifacts(id), "control.sock"), resolve),
      );
      try {
        const result = await requestWorker(store, id, "stop", { timeout: 40 });
        assert.equal(result?.status, "outcome_unknown");
        assert.match(
          submitted.requestId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        assert.equal(result.requestId, submitted.requestId);
        assert.equal(
          await requestWorker(store, id, "ping", { timeout: 40 }),
          null,
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
      assert.equal(
        await requestWorker(store, id, "stop", { timeout: 40 }),
        null,
      );
    });
});

test("private control refuses malformed client UUIDs before its handler and accepts legacy requests", async (t) => {
  const net = await import("node:net"),
    store = new Store(temporary(t)),
    id = randomUUID();
  let calls = 0;
  const close = await serveWorker(store, id, () => {
    calls++;
    return { status: "queued" };
  });
  const send = (requestId) =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(
        path.join(store.artifacts(id), "control.sock"),
      );
      let output = "";
      socket.on("error", reject);
      socket.on("connect", () =>
        socket.write(
          JSON.stringify({ workerId: id, action: "stop", requestId }) + "\n",
        ),
      );
      socket.on("data", (chunk) => {
        output += chunk;
      });
      socket.on("end", () => resolve(JSON.parse(output)));
    });
  try {
    for (const requestId of ["bad", 42, null, "a".repeat(500), "a".repeat(36)])
      assert.equal((await send(requestId)).status, "invalid_request");
    assert.equal(calls, 0);
    assert.equal((await send(undefined)).status, "queued");
    assert.equal((await send(randomUUID())).status, "queued");
    assert.equal(calls, 2);
  } finally {
    await close();
  }
});

test("private control correlates an asynchronous accepted reply with the client UUID", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID();
  let receivedId;
  const close = await serveWorker(store, id, async (_action, requestId) => {
    receivedId = requestId;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { status: "queued", requestId };
  });
  try {
    const result = await requestWorker(store, id, "stop");
    assert.match(receivedId, /^[0-9a-f-]{36}$/);
    assert.equal(result.status, "queued");
    assert.equal(result.requestId, receivedId);
  } finally {
    await close();
  }
});
