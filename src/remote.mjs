import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { shellQuote as q } from "./process.mjs";
import { readSnapshot, readRegular, saveSnapshot } from "./manifest.mjs";
import { remotePaths, tmuxCommand } from "./ssh.mjs";
import { PluginError } from "./result.mjs";
import { guestBackend, guestInstallCommand } from "./guest-herdr.mjs";
import { recordAdapter } from "./adapters.mjs";
import { setTimeout as delay } from "node:timers/promises";
const directory = fileURLToPath(new URL(".", import.meta.url));
export class Remote {
  constructor(ssh) {
    this.ssh = ssh;
  }
  command(r, command, options) {
    return this.ssh.exec(r, command, options);
  }
  guestCommand(r, operation) {
    const { source, state } = remotePaths(r);
    return [
      ...(operation === "attach"
        ? []
        : ["flock", q(state + "/herdr-worker.lock")]),
      "node",
      q(state + "/tools/guest-herdr.mjs"),
      q(operation),
      q(state),
      q(r.id),
      q(source),
    ].join(" ");
  }
  guest(r, operation) {
    return JSON.parse(this.command(r, this.guestCommand(r, operation)).stdout);
  }
  transfer(r, mode, temporary, input) {
    const { source, state } = remotePaths(r);
    const command = [
      "node",
      q(state + "/tools/remote-transfer.mjs"),
      q(mode),
      q(source),
      q(temporary),
      q(
        JSON.stringify({
          maxFiles: r.config.maxFiles,
          maxFileBytes: r.config.maxFileBytes,
          maxUploadBytes: r.config.maxUploadBytes,
          excludedPaths: r.config.excludedPaths,
        }),
      ),
    ].join(" ");
    return JSON.parse(
      this.command(r, command, {
        input: JSON.stringify(input ?? {}),
        maxBuffer: r.config.maxUploadBytes * 3 + 1024 * 1024,
      }).stdout,
    );
  }
  async setup(r) {
    const { source, state } = remotePaths(r);
    if (r.vm?.hostKeySource === "provisioned") await this.waitReady(r);
    this.command(
      r,
      `set -eu\ncloud-init status --wait >/dev/null\nexport DEBIAN_FRONTEND=noninteractive\napt-get update -qq\napt-get install -y -qq nodejs npm git tmux util-linux curl ca-certificates xz-utils >/dev/null\numask 077\nmkdir -p ${q(state + "/tools")}\n`,
    );
    // These modules contain only public source and no configuration/credentials.
    for (const name of [
      "remote-transfer",
      "guest-herdr",
      "manifest",
      "process",
      "result",
      "state",
      "config",
      "constants",
      "adapters",
    ]) {
      const bytes = fs.readFileSync(path.join(directory, name + ".mjs"));
      this.command(r, `cat > ${q(state + "/tools/" + name + ".mjs")}`, {
        input: bytes,
      });
    }
    if (guestBackend(r) === "herdr")
      this.command(r, guestInstallCommand(state));
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
      this.command(r, `cat > ${q(state + "/tools/" + name)}`, {
        input: fs.readFileSync(new URL("../" + name, import.meta.url)),
      });
    const base = readSnapshot(r.baseline);
    if (base.digest !== r.uploadApproval?.digest)
      throw new PluginError(
        "upload_approval_required",
        "Baseline differs from the reviewed digest.",
      );
    const checkpoint = { workerId: r.id, sourceDigest: base.digest };
    const saved = this.command(r, `cat ${q(state + "/identity.json")}`, {
      check: false,
    });
    if (saved.status === 0) {
      let identity;
      try {
        identity = JSON.parse(saved.stdout);
      } catch {
        throw new PluginError(
          "setup_mismatch",
          "Remote setup identity is incomplete. Existing source was retained.",
        );
      }
      if (identity.workerId !== r.id || identity.sourceDigest !== base.digest)
        throw new PluginError(
          "setup_mismatch",
          "Remote source belongs to another setup. Existing source was retained.",
        );
      this.command(
        r,
        `test -d ${q(source)} && test -s ${q(state + "/launch.sh")}`,
      );
      return { ...checkpoint, installedVersion: recordAdapter(r).version };
    }
    const existing = this.command(r, `test -d ${q(source)}`, { check: false });
    const result =
      existing.status === 0
        ? this.transfer(r, "verify", state + "/setup-check-" + randomUUID())
        : this.transfer(r, "upload", state + "/upload-" + randomUUID(), {
            digest: base.digest,
            files: base.files.map((f) => ({
              ...f,
              bytes: readRegular(
                path.join(base.directory, "files"),
                f.path,
                r.config.maxFileBytes,
              ).bytes.toString("base64"),
            })),
          });
    if (result.digest !== base.digest)
      throw new PluginError("upload_corrupt", "Remote upload digest differs.");
    const adapter = recordAdapter(r);
    this.command(
      r,
      `set -eu\ncd ${q(source)}\ngit init -q\n${adapter.install || ":"}\n`,
    );
    if (adapter.versionCommand) {
      const version = this.command(r, adapter.versionCommand).stdout.trim();
      if (!version.split(/\s+/).includes(adapter.version))
        throw new PluginError(
          "agent_version_mismatch",
          "Installed remote agent version differs from the frozen adapter.",
        );
    }
    const launch = `#!/bin/bash\nset -eu\ncd ${q(source)}\nif [ -e ${q(state + "/started")} ]; then\nexec bash -lc ${q(adapter.resume)}\nelse\ntouch ${q(state + "/started")}\nexec bash -lc ${q(adapter.launch)}\nfi\n`;
    this.command(r, `cat > ${q(state + "/launch.sh")}`, { input: launch });
    this.command(r, `cat > ${q(state + "/identity.json")}`, {
      input: JSON.stringify(checkpoint),
    });
    return { ...checkpoint, installedVersion: adapter.version };
  }
  async waitReady(r, { attempts = 24, interval = 2500 } = {}) {
    for (let i = 0; i < attempts; i++) {
      try {
        this.command(r, "true", { timeout: 20000 });
        return;
      } catch {
        if (i + 1 < attempts) await delay(interval);
      }
    }
    throw new PluginError(
      "ssh_not_ready",
      "Pinned SSH identity is not ready. Use Reconnect after boot completes; verification was not weakened.",
    );
  }
  prepareSnapshot(r) {
    // A clone must consume its own instance metadata and new authenticated user-data.
    return this.command(r, "set -eu\ncloud-init clean\nsync");
  }
  shutdown(r) {
    // Return before shutdown severs SSH; a lost acknowledgement remains unknown.
    return this.command(
      r,
      "set -eu\nnohup sh -c 'sleep 2; /sbin/shutdown -h now' </dev/null >/dev/null 2>&1 &",
    );
  }
  async checkpoint(r) {
    if (guestBackend(r) === "herdr") this.guest(r, "checkpoint");
    const { source, state } = remotePaths(r);
    this.command(
      r,
      `test -d ${q(source)} && test -s ${q(state + "/identity.json")}`,
    );
    const sourceSnapshot = state + "/checkpoint-source-" + randomUUID();
    const captured = this.transfer(r, "checkpoint", sourceSnapshot);
    const checkpoint = {
      workerId: r.id,
      sourceDigest: r.baselineDigest,
      currentSourceDigest: captured.digest,
      checkpointDigest: r.checkpointDigest,
      sourceSnapshot,
      at: new Date().toISOString(),
    };
    this.command(
      r,
      `umask 077; cat > ${q(state + "/checkpoint.tmp")} && mv ${q(state + "/checkpoint.tmp")} ${q(state + "/checkpoint.json")} && sync`,
      { input: JSON.stringify(checkpoint) },
    );
    this.command(
      r,
      `find ${q(state)} -mindepth 1 -maxdepth 1 -type d -name 'checkpoint-source-*' ! -name ${q(path.posix.basename(sourceSnapshot))} -exec rm -rf -- {} +`,
    );
    return checkpoint;
  }
  async quiesce(r) {
    if (guestBackend(r) === "herdr") {
      this.command(r, `set -eu\n${r.config.adapter.quiesce || ":"}`);
      this.guest(r, "quiesce");
      this.command(r, "sync");
      return;
    }
    const { state } = remotePaths(r),
      session = `herdr-${r.id}`;
    this.command(
      r,
      `set -eu\n${r.config.adapter.quiesce || ":"}\nif tmux has-session -t ${q(session)} 2>/dev/null; then tmux kill-session -t ${q(session)}; fi\nrm -f ${q(state + "/resume-approved")}\nsync`,
    );
  }
  async verifyResume(r) {
    if (r.vm?.hostKeySource === "provisioned") await this.waitReady(r);
    const { state } = remotePaths(r);
    const identity = JSON.parse(
      this.command(r, `cat ${q(state + "/identity.json")}`).stdout,
    );
    const checkpoint = JSON.parse(
      this.command(r, `cat ${q(state + "/checkpoint.json")}`).stdout,
    );
    if (
      identity.workerId !== r.id ||
      checkpoint.workerId !== r.id ||
      checkpoint.sourceDigest !== r.snapshot.checkpoint.sourceDigest ||
      checkpoint.at !== r.snapshot.checkpoint.at
    )
      throw new PluginError(
        "restore_mismatch",
        "Restored worker checkpoint does not match the saved snapshot.",
      );
    const restored = this.transfer(
      r,
      "verify",
      state + "/restore-check-" + randomUUID(),
    );
    if (restored.digest !== r.snapshot.checkpoint.currentSourceDigest)
      throw new PluginError(
        "restore_mismatch",
        "Restored source differs from the quiesced source checkpoint.",
      );
    this.activate(r);
  }
  activate(r) {
    const { source, state } = remotePaths(r);
    const identity = JSON.parse(
      this.command(r, `cat ${q(state + "/identity.json")}`).stdout,
    );
    if (identity.workerId !== r.id)
      throw new PluginError(
        "restore_mismatch",
        "Remote worker identity differs.",
      );
    const adapter = recordAdapter(r);
    this.command(
      r,
      `set -eu\ntest -d ${q(source)}\ntest -s ${q(state + "/launch.sh")}\ncd ${q(source)}\n${adapter.authCheck || ":"}\n${adapter.restart || ":"}\ntouch ${q(state + "/resume-approved")}`,
    );
  }
  auth(r) {
    const { source } = remotePaths(r);
    const command = recordAdapter(r).authCheck;
    if (!command) return { status: "cli-managed", verified: false };
    try {
      this.command(r, `cd ${q(source)} && ${command}`);
    } catch {
      throw new PluginError(
        "auth_required",
        "Remote agent login is required. Choose Login; host coding-agent credentials are never copied.",
      );
    }
    return { status: "authenticated", verified: true };
  }
  ensureWorker(r, { resumeApproved = false } = {}) {
    if (guestBackend(r) === "herdr")
      return this.guest(r, resumeApproved ? "resume" : "ensure");
    return this.command(r, tmuxCommand(r));
  }
  attach(r) {
    const command =
      guestBackend(r) === "herdr"
        ? this.guestCommand(r, "attach")
        : `test "$(tmux display-message -p -t ${q("herdr-" + r.id)} '#{pane_dead}')" = 0 && exec tmux attach-session -t ${q("herdr-" + r.id)}`;
    return this.ssh.interactive(r, command, {
      agentKind: recordAdapter(r).capabilities.herdrDetectionKind,
    });
  }
  login(r) {
    return this.ssh.interactive(r, recordAdapter(r).login);
  }
  inspectSession(r) {
    if (guestBackend(r) === "herdr") return this.guest(r, "inspect");
    const result = this.command(
      r,
      `tmux display-message -p -t ${q("herdr-" + r.id)} '#{pane_id} #{pane_pid} #{pane_dead} #{pane_dead_status}'`,
      { check: false },
    );
    if (result.status !== 0) return { status: "unavailable" };
    const [paneId, pid, dead, exitCode] = result.stdout.trim().split(/\s+/);
    return {
      status: dead === "1" ? "agent-exited" : "detached",
      paneId,
      pid: Number(pid),
      exitCode: dead === "1" ? Number(exitCode) : null,
    };
  }
  restartAgent(r) {
    if (guestBackend(r) === "herdr") return this.guest(r, "restart");
    // respawn-pane without -k refuses to replace a running agent, including a race.
    const session = q("herdr-" + r.id),
      { state } = remotePaths(r);
    this.command(
      r,
      `test "$(tmux display-message -p -t ${session} '#{pane_dead}')" = 1 && tmux respawn-pane -t ${session} ${q("bash " + q(state + "/launch.sh"))}`,
    );
  }
  async exportSnapshot(r, destination) {
    const { state } = remotePaths(r);
    const result = this.transfer(
      r,
      "export",
      state + "/export-" + randomUUID(),
    );
    const snapshot = saveSnapshot(
      destination,
      result.files.map((f) => ({
        ...f,
        bytes: Buffer.from(f.bytes, "base64"),
      })),
      result.excluded,
    );
    if (snapshot.digest !== result.digest)
      throw new PluginError("export_corrupt", "Remote export digest mismatch.");
    return snapshot;
  }
}
