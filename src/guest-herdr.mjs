// Deployable guest runtime. All CLI calls target this worker's private socket.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const q = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const GUEST_HERDR_RELEASE = {
  version: "0.9.5",
  x86_64: {
    asset: "herdr-linux-x86_64",
    sha256: "14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d",
  },
  aarch64: {
    asset: "herdr-linux-aarch64",
    sha256: "17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c",
  },
};
export function guestBackend(r) {
  return r.guestBackend ?? "tmux";
}
export function guestInstallCommand(state) {
  const release = GUEST_HERDR_RELEASE;
  return `set -eu\numask 077\ncase "$(uname -m)" in\nx86_64) asset=${q(release.x86_64.asset)}; digest=${q(release.x86_64.sha256)} ;;\naarch64) asset=${q(release.aarch64.asset)}; digest=${q(release.aarch64.sha256)} ;;\n*) exit 1 ;;\nesac\ncurl --fail --location --proto '=https' --tlsv1.2 ${q(`https://github.com/herdrdev/herdr/releases/download/v${release.version}/`)}"$asset" -o ${q(state + "/tools/herdr.download")}\nprintf '%s  %s\\n' "$digest" ${q(state + "/tools/herdr.download")} | sha256sum -c - >/dev/null\nchmod 755 ${q(state + "/tools/herdr.download")}\nmv ${q(state + "/tools/herdr.download")} ${q(state + "/tools/herdr")}`;
}
export async function guestHerdr(op, state, workerId, source) {
  const base = state + "/herdr",
    binary = state + "/tools/herdr",
    metadataFile = state + "/herdr-worker.json",
    approvalFile = state + "/resume-approved",
    writerLease = state + "/herdr-agent.lock";
  // Disk approval alone never authorizes an ordinary reconnect. Consume it before
  // setup can fail; only the caller that just completed Resume gates may use it.
  const approved = op === "resume" && fs.existsSync(approvalFile);
  if (["ensure", "resume", "restart", "quiesce"].includes(op))
    fs.rmSync(approvalFile, { force: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("HERDR_") && !["ENV", "BASH_ENV"].includes(key),
    ),
  );
  Object.assign(env, {
    HOME: base + "/home",
    SHELL: "/bin/sh",
    HERDR_SESSION: "worker-" + workerId,
    HERDR_SOCKET_PATH: state + "/herdr.sock",
    HERDR_CONFIG_PATH: base + "/config/herdr/config.toml",
    XDG_CONFIG_HOME: base + "/config",
    XDG_STATE_HOME: base + "/state",
    XDG_CACHE_HOME: base + "/cache",
    XDG_RUNTIME_DIR: base + "/runtime",
  });
  const read = () => {
    if (!fs.existsSync(metadataFile)) return null;
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    if (metadata.workerId !== workerId) throw Error("guest_worker_mismatch");
    return metadata;
  };
  const save = (m) => {
    fs.writeFileSync(metadataFile + ".tmp", JSON.stringify(m), { mode: 0o600 });
    fs.renameSync(metadataFile + ".tmp", metadataFile);
    return m;
  };
  const cli = (args, check = true) => {
    const r = spawnSync(binary, args, {
      env,
      cwd: source,
      encoding: "utf8",
      timeout: 15000,
    });
    if (check && r.status !== 0) throw Error("guest_herdr_command_failed");
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      /* Commands such as pane run return no JSON. */
    }
    return { ...r, result: json?.result };
  };
  const online = () => cli(["pane", "list"], false).status === 0;
  const writerLive = () => {
    const lock = spawnSync("flock", ["--nonblock", writerLease, "true"]);
    if (lock.status === 0) return false;
    if (lock.status === 1) return true;
    throw Error("guest_writer_lease_unavailable");
  };
  const requireNoWriter = () => {
    if (writerLive()) throw Error("guest_writer_live");
  };
  const inspect = () => {
    const m = read(),
      observedAt = new Date().toISOString();
    if (!m || !online())
      return {
        ...m,
        backend: "herdr",
        status: "unavailable",
        pid: null,
        shellPid: null,
        agent: null,
        observedAt,
      };
    const pane = cli(["pane", "list"]).result.panes.find(
      (p) => p.terminal_id === m.terminalId,
    );
    if (!pane)
      return {
        ...m,
        status: "unavailable",
        pid: null,
        shellPid: null,
        agent: null,
        observedAt,
      };
    const info = cli(["pane", "process-info", "--pane", pane.pane_id]).result
      .process_info;
    const live =
      info.foreground_process_group_id !== info.shell_pid &&
      info.foreground_processes.length > 0;
    const agent =
      cli(["agent", "get", pane.pane_id], false).result?.agent ?? null;
    return {
      ...m,
      paneId: pane.pane_id,
      workspaceId: pane.workspace_id,
      status: live ? "detached" : "agent-exited",
      pid: live ? info.foreground_process_group_id : null,
      shellPid: info.shell_pid,
      agent,
      observedAt,
    };
  };
  if (op === "inspect") return inspect();
  if (op === "checkpoint") {
    requireNoWriter();
    return {
      backend: "herdr",
      status: "quiesced",
      observedAt: new Date().toISOString(),
    };
  }
  if (op === "quiesce") {
    if (online()) cli(["server", "stop"]);
    else requireNoWriter();
    for (let i = 0; i < 100 && fs.existsSync(env.HERDR_SOCKET_PATH); i++)
      await delay(50);
    if (fs.existsSync(env.HERDR_SOCKET_PATH))
      throw Error("guest_herdr_stop_unconfirmed");
    requireNoWriter();
    return {
      backend: "herdr",
      status: "quiesced",
      observedAt: new Date().toISOString(),
    };
  }
  if (op === "attach") {
    const observed = inspect();
    if (observed.status !== "detached") throw Error("guest_agent_not_running");
    // A terminal can outlive its child. Watch the observed process identity, and
    // end only this attachment when that process exits (including PID reuse).
    const processIdentity = () => {
      try {
        const stat = fs.readFileSync(`/proc/${observed.pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
        return { state: fields[0], started: fields[19] };
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ESRCH") return null;
        throw error;
      }
    };
    const initial = processIdentity();
    if (!initial || ["Z", "X"].includes(initial.state))
      throw Error("guest_agent_not_running");
    const client = spawn(binary, ["terminal", "attach", observed.terminalId], {
      env,
      cwd: source,
      stdio: "inherit",
    });
    let childExited = false;
    const monitor = setInterval(() => {
      const current = processIdentity();
      if (
        !current ||
        current.started !== initial.started ||
        ["Z", "X"].includes(current.state)
      ) {
        childExited = true;
        clearInterval(monitor);
        client.kill("SIGTERM");
      }
    }, 200);
    try {
      const code = await new Promise((resolve, reject) => {
        client.once("error", reject);
        client.once("exit", (status) => resolve(status));
      });
      process.exitCode = childExited ? 0 : (code ?? 1);
    } finally {
      clearInterval(monitor);
    }
    return null;
  }
  if (!["ensure", "resume", "restart"].includes(op))
    throw Error("guest_herdr_unknown_operation");
  if (op === "resume" && !approved)
    throw Error("guest_resume_approval_required");
  const serverLost = !online();
  if (op === "restart" && serverLost) throw Error("guest_resume_required");
  if (serverLost) {
    requireNoWriter();
    const previous = read();
    if (previous) save({ ...previous, resumeRequired: true });
    for (const dir of [
      env.HOME,
      env.XDG_RUNTIME_DIR,
      env.XDG_STATE_HOME,
      env.XDG_CACHE_HOME,
      base + "/config/herdr",
    ])
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      env.HERDR_CONFIG_PATH,
      "onboarding = false\n[session]\nresume_agents_on_restore = false\n",
      { mode: 0o600 },
    );
    const log = fs.openSync(base + "/server.log", "a", 0o600);
    const server = spawn(binary, ["server"], {
      cwd: source,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    server.unref();
    fs.closeSync(log);
    for (let i = 0; i < 100 && !online(); i++) await delay(50);
    if (!online()) throw Error("guest_herdr_server_unavailable");
  }
  const previous = read(),
    observed = inspect();
  const started = fs.existsSync(state + "/started");
  if (previous?.resumeRequired && (!approved || op === "restart"))
    throw Error("guest_resume_required");
  if (observed.status === "detached") {
    if (op === "restart") throw Error("guest_agent_live");
    return save({ ...observed, resumeRequired: false });
  }
  if (op === "ensure" && previous && !serverLost && !approved) return observed;
  if (started && op !== "restart" && !approved)
    throw Error("guest_resume_required");
  // A launch intent remains durable even if the client loses its acknowledgement.
  if (previous?.launchAttempted && !started && !approved && op === "ensure")
    throw Error("guest_launch_uncertain");
  requireNoWriter();
  let m = previous;
  const panes = cli(["pane", "list"]).result.panes;
  const existing = panes.find((p) => p.terminal_id === m?.terminalId);
  if (existing)
    m = { ...m, paneId: existing.pane_id, workspaceId: existing.workspace_id };
  else {
    if (op === "restart") throw Error("guest_resume_required");
    const created = cli([
      "workspace",
      "create",
      "--cwd",
      source,
      "--no-focus",
    ]).result;
    m = {
      backend: "herdr",
      workerId,
      session: env.HERDR_SESSION,
      workspaceId: created.workspace.workspace_id,
      paneId: created.root_pane.pane_id,
      terminalId: created.root_pane.terminal_id,
    };
  }
  save({ ...m, launchAttempted: true, resumeRequired: false });
  // Herdr owns private XDG paths; the agent retains the guest login environment.
  const agentEnvironment = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
  ];
  const launch = [
    "flock",
    "--nonblock",
    "--no-fork",
    q(writerLease),
    "env",
    ...agentEnvironment.flatMap((name) =>
      process.env[name] === undefined ? ["-u", q(name)] : [],
    ),
    ...agentEnvironment
      .filter((name) => process.env[name] !== undefined)
      .map((name) => q(name + "=" + process.env[name])),
    "bash",
    q(state + "/launch.sh"),
  ].join(" ");
  cli(["pane", "run", m.paneId, launch]);
  for (let i = 0; i < 60; i++) {
    const result = inspect();
    if (result.status === "detached") return result;
    await delay(50);
  }
  return inspect();
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [op, state, workerId, source] = process.argv.slice(2);
    const result = await guestHerdr(op, state, workerId, source);
    if (result) process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
