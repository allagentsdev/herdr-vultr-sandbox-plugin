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

test("clean and truncated owner replies settle instead of hanging action dispatch", async (t) => {
  const net = await import("node:net");
  for (const reply of ["", '{"status":"partial"']) {
    const store = new Store(temporary(t)),
      id = randomUUID(),
      file = path.join(store.artifacts(id), "control.sock");
    const server = net.createServer((socket) => {
      socket.on("data", () => socket.end(reply));
    });
    await new Promise((resolve) => server.listen(file, resolve));
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error("IPC did not settle")), 300);
      timer.unref();
    });
    assert.equal(
      await Promise.race([
        requestWorker(store, id, "ping", { timeout: 40 }),
        timeout,
      ]),
      null,
    );
    await new Promise((resolve) => server.close(resolve));
  }
});
