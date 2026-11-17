import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { runSync, shellQuote as q } from "./process.mjs";
import { PluginError } from "./result.mjs";
import { assertPrivateFile } from "./config.mjs";
const fail = (code, message) => {
  throw new PluginError(code, message);
};
export function clientPublicKey(config) {
  assertPrivateFile(config.sshPrivateKey);
  const publicKey = fs.readFileSync(config.sshPublicKey, "utf8").trim();
  if (!/^ssh-(ed25519|rsa) [A-Za-z0-9+/]+=*(?: [^\r\n]*)?$/.test(publicKey))
    fail("invalid_key", "Supply only the intended public SSH key.");
  const derived = runSync(
    "ssh-keygen",
    ["-y", "-P", "", "-f", config.sshPrivateKey],
    { check: false },
  );
  if (derived.status !== 0)
    fail(
      "client_key_unusable",
      "Use a dedicated unencrypted client SSH key in a protected file. Batch-mode SSH cannot unlock an encrypted key or use a host agent.",
    );
  if (
    derived.stdout.trim().split(/\s+/).slice(0, 2).join(" ") !==
    publicKey.split(/\s+/).slice(0, 2).join(" ")
  )
    fail(
      "client_key_mismatch",
      "Configured client SSH public and private keys do not match; no compute was allocated.",
    );
  return publicKey;
}
export function sshArgs(config, r, knownHosts, { tty = false } = {}) {
  if (!r.vm?.hostKey)
    fail(
      "pin_required",
      "Pin the server SSH host identity using a fingerprint obtained through the Vultr console.",
    );
  if (!isIP(r.vm.ip))
    fail("invalid_ip", "Provider did not supply a valid server IP.");
  return [
    "-F",
    "/dev/null",
    "-i",
    config.sshPrivateKey,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    `HostKeyAlias=herdr-${r.id}-${r.vm.serverId}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    tty ? "-tt" : "-T",
    `root@${r.vm.ip}`,
  ];
}
export function verifyHostKey(scan, expected) {
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(expected))
    fail(
      "invalid_fingerprint",
      "Supply a console-verified SHA256 host fingerprint.",
    );
  for (const line of scan.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length !== 3 ||
      fields[1] !== "ssh-ed25519" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(fields[2])
    )
      continue;
    const fingerprint =
      "SHA256:" +
      createHash("sha256")
        .update(Buffer.from(fields[2], "base64"))
        .digest("base64")
        .replace(/=+$/, "");
    if (fingerprint === expected) return `${fields[1]} ${fields[2]}`;
  }
  fail(
    "host_key_mismatch",
    "SSH key scan does not match the trusted fingerprint. No connection made.",
  );
}
export function remotePaths(r) {
  return {
    source: `/srv/herdr/workers/${r.id}/source`,
    state: `/var/lib/herdr/workers/${r.id}`,
  };
}
export function tmuxCommand(r) {
  const { state } = remotePaths(r),
    session = `herdr-${r.id}`;
  // A dead tmux pane is retained. A second connection cannot launch another agent.
  // Across a reboot tmux is gone, but the disk marker selects the configured resume command.
  return `set -eu\nexec 9>${q(state + "/tmux.lock")}\nflock 9\nif ! tmux has-session -t ${q(session)} 2>/dev/null; then\nif [ -e ${q(state + "/started")} ]; then test -f ${q(state + "/resume-approved")}; fi\ntmux new-session -d -s ${q(session)} \\; set-option -t ${q(session)} remain-on-exit on \\; respawn-pane -k -t ${q(session)} ${q(`bash ${q(state + "/launch.sh")}`)}\nfi\ntmux set-hook -t ${q(session)} pane-died ${q(`detach-client -s ${session}`)}\nflock -u 9`;
}
export class SSH {
  constructor(store, config, { run = runSync, spawnProcess = spawn } = {}) {
    this.store = store;
    this.config = config;
    this.run = run;
    this.spawnProcess = spawnProcess;
  }
  knownHosts(r) {
    const file = path.join(
      this.store.artifacts(r.id),
      `known-hosts-${r.vm.serverId}`,
    );
    fs.writeFileSync(file, `herdr-${r.id}-${r.vm.serverId} ${r.vm.hostKey}\n`, {
      mode: 0o600,
    });
    fs.chmodSync(file, 0o600);
    return file;
  }
  exec(
    r,
    command,
    {
      input,
      tty = false,
      maxBuffer = 32 * 1024 * 1024,
      agentKind,
      check = true,
      timeout = 300000,
    } = {},
  ) {
    const env = { ...process.env };
    delete env.HERDR_AGENT;
    if (tty && agentKind) env.HERDR_AGENT = agentKind;
    return this.run(
      "ssh",
      [...sshArgs(this.config, r, this.knownHosts(r), { tty }), command],
      {
        input,
        maxBuffer,
        env,
        check,
        timeout,
        killSignal: "SIGKILL",
        ...(tty ? { stdio: "inherit" } : {}),
      },
    );
  }
  interactive(r, command, { agentKind } = {}) {
    const env = { ...process.env };
    delete env.HERDR_AGENT;
    if (agentKind) env.HERDR_AGENT = agentKind;
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(
        "ssh",
        [
          ...sshArgs(this.config, r, this.knownHosts(r), { tty: true }),
          command,
        ],
        { env, stdio: "inherit" },
      );
      child.once("error", () =>
        reject(
          new PluginError(
            "transport_failed",
            "SSH transport could not start. Remote worker state is unchanged.",
          ),
        ),
      );
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  }
  async pin(r, server, fingerprint) {
    if (!isIP(server.main_ip)) fail("invalid_ip", "No public IPv4 returned.");
    const scan = this.run(
      "ssh-keyscan",
      ["-T", "10", "-t", "ed25519", server.main_ip],
      { check: false },
    ).stdout;
    const key = verifyHostKey(scan, fingerprint);
    return this.store.update(r.id, (v) => {
      if (
        !v.vm ||
        v.vm.serverId !== r.vm?.serverId ||
        v.vm.serverId !== server.id
      )
        fail(
          "stale_server",
          "Server identity changed while waiting for host approval. No pin was saved.",
        );
      return {
        ...v,
        vm: { ...v.vm, ip: server.main_ip, hostKey: key },
        phase: v.snapshot ? "restore-verification" : "setup-required",
      };
    });
  }
}
