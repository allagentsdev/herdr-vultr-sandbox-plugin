import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { PluginError } from "./result.mjs";
const socketPath = (store, id) => {
  const direct = path.join(store.artifacts(id), "control.sock");
  if (Buffer.byteLength(direct) < 96) return direct;
  const directory = "/tmp/herdr-vultr-" + process.getuid();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid()
  )
    throw new PluginError(
      "unsafe_control_directory",
      "Worker control directory must be private and owned.",
    );
  fs.chmodSync(directory, 0o700);
  return path.join(
    directory,
    createHash("sha256").update(direct).digest("hex").slice(0, 32) + ".sock",
  );
};
export function requestWorker(
  store,
  id,
  action = "ping",
  { timeout = 1500 } = {},
) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath(store, id));
    let text = "",
      settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout, () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("connect", () =>
      socket.write(JSON.stringify({ workerId: id, action }) + "\n"),
    );
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.length > 8192) return finish(null);
      if (text.includes("\n")) {
        try {
          finish(JSON.parse(text.split("\n")[0]));
        } catch {
          finish(null);
        }
      }
    });
  });
}
export function hasLiveOwner(store, id) {
  try {
    const pid = Number(fs.readFileSync(store.file(id) + ".owner.lock", "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export async function serveWorker(store, id, handler) {
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const lifetime = store.withLock(
    id,
    async () => {
      if (await requestWorker(store, id))
        throw new PluginError(
          "worker_open",
          "This worker already has a live pane.",
        );
      const file = socketPath(store, id);
      fs.rmSync(file, { force: true });
      const server = net.createServer((socket) => {
        let text = "";
        socket.setTimeout(1500, () => socket.destroy());
        socket.on("error", () => {});
        socket.on("data", (chunk) => {
          text += chunk;
          if (text.length > 8192) return socket.destroy();
          if (!text.includes("\n")) return;
          socket.pause();
          let result;
          try {
            const request = JSON.parse(text.split("\n")[0]);
            if (request.workerId !== id) throw Error();
            result = handler(request.action);
          } catch {
            result = { status: "invalid_request" };
          }
          socket.end(JSON.stringify(result) + "\n");
        });
      });
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(file, resolve);
        });
        fs.chmodSync(file, 0o600);
        let release, closing;
        const stop = new Promise((resolve) => {
          release = resolve;
        });
        readyResolve(
          () =>
            (closing ??= (async () => {
              release();
              await lifetime;
            })()),
        );
        await stop;
      } finally {
        if (server.listening)
          await new Promise((resolve) => server.close(resolve));
        fs.rmSync(file, { force: true });
      }
    },
    { suffix: "owner", attempts: 3, interval: 20 },
  );
  lifetime.catch((error) =>
    readyReject(
      error.code === "association_busy"
        ? new PluginError("worker_open", "This worker already has a live pane.")
        : error,
    ),
  );
  return ready;
}
