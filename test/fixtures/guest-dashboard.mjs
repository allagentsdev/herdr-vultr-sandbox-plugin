// Actual dashboard/helper/terminal attach; provider and auth boundary are synthetic.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/state.mjs";
import { runWorker } from "../../src/pane.mjs";
const [state, id, source] = process.argv.slice(2),
  helper = fileURLToPath(new URL("../../src/guest-herdr.mjs", import.meta.url)),
  store = new Store(state + "/dashboard-state");
try {
  store.get(id);
} catch {
  await store.create({
    id,
    namespace: "synthetic",
    localRoot: source,
    guestBackend: "herdr",
    phase: "ready",
    vm: { serverId: "synthetic", hostKey: "synthetic", initialized: true },
    config: {
      adapter: { launch: "synthetic", resume: "synthetic", authCheck: "true" },
    },
  });
}
function operation(op) {
  const r = spawnSync(
    "flock",
    [
      state + "/herdr-worker.lock",
      process.execPath,
      helper,
      op,
      state,
      id,
      source,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw Error(r.stderr);
  return JSON.parse(r.stdout);
}
await runWorker({
  store,
  id,
  initialAction: "reconnect",
  resolvePane: () => "synthetic:dashboard",
  registerSession: () => false,
  services: {
    life: { owned: async () => ({ powerState: "running" }) },
    remote: {
      auth: () => {},
      ensureWorker: () => operation("ensure"),
      inspectSession: () => operation("inspect"),
      attach: () =>
        new Promise((resolve, reject) => {
          const p = spawn(
            process.execPath,
            [helper, "attach", state, id, source],
            { stdio: "inherit" },
          );
          p.once("error", reject);
          p.once("exit", (code, signal) => resolve({ code, signal }));
        }),
    },
  },
});
console.log("WORKER_DASHBOARD_CLOSED");
