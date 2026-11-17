import { fileURLToPath } from "node:url";
import { SSH } from "../../src/ssh.mjs";
import { runSync } from "../../src/process.mjs";
const directory = process.argv[2];
const ssh = new SSH(
  { artifacts: () => directory },
  { sshPrivateKey: directory + "/unused-test-key" },
  {
    run: (_command, _args, options) =>
      runSync(
        process.execPath,
        [fileURLToPath(new URL("./transport-screen.mjs", import.meta.url))],
        options,
      ),
  },
);
ssh.exec(
  {
    id: "fixture",
    vm: { serverId: 1, ip: "192.0.2.1", hostKey: "ssh-ed25519 AAAA" },
  },
  "synthetic fixture",
  { tty: true, agentKind: "codex" },
);
process.stdout.write("\nTRANSPORT_RETURNED_TO_DASHBOARD\n");
// Keep the same owning pane process alive, with no agent hint.
await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.once("data", resolve);
});

process.stdin.pause();
console.log("FOREGROUND_FIXTURE_CLOSED");
