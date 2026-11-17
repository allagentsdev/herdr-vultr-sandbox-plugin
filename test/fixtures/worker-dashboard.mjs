import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Store, namespace } from "../../src/state.mjs";
import { SSH } from "../../src/ssh.mjs";
import { Remote } from "../../src/remote.mjs";
import { runWorker } from "../../src/pane.mjs";
const root = process.argv[2];
process.env.HERDR_BIN_PATH = process.argv[3];
const store = new Store(path.join(root, "plugin-state")),
  id = "00000000-0000-0000-0000-000000000001";
await store.create({
  id,
  namespace: namespace(),
  localRoot: root,
  vm: {
    serverId: 1,
    ip: "192.0.2.1",
    hostKey: "ssh-ed25519 AAAA",
    initialized: true,
  },
  phase: "ready",
  config: {
    herdrDetectionIdentifier: "codex",
    sshPrivateKey: root + "/unused-test-key",
    adapter: { launch: "agent", resume: "agent resume", authCheck: "true" },
  },
});
const ssh = new SSH(
  store,
  { sshPrivateKey: root + "/unused-test-key" },
  {
    run: () => ({ status: 0, stdout: "%0 123 0\n" }),
    spawnProcess: (_command, _args, options) =>
      spawn(
        process.execPath,
        [fileURLToPath(new URL("./transport-screen.mjs", import.meta.url))],
        options,
      ),
  },
);
const remote = new Remote(ssh),
  life = { owned: async () => ({ powerState: "running" }) };
await runWorker({
  store,
  id,
  initialAction: "reconnect",
  services: { ssh, remote, life },
});
console.log("WORKER_DASHBOARD_CLOSED");
