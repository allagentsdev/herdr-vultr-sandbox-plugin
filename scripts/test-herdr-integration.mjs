import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const binary = process.env.VULTR_HERDR_TEST_BIN;
if (!binary || !path.isAbsolute(binary))
  throw Error(
    "Set VULTR_HERDR_TEST_BIN to the absolute installed Herdr binary (not a host-routing shim).",
  );
if (process.platform !== "linux")
  throw Error(
    "This isolated runtime harness currently requires Linux; no macOS runtime certification is implied.",
  );
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vultr-herdr-integration-")),
  session = "vultr-parity-" + process.pid;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("HERDR_") && !["ENV", "BASH_ENV"].includes(key),
  ),
);
Object.assign(env, {
  XDG_CONFIG_HOME: root + "/config",
  XDG_STATE_HOME: root + "/state",
  XDG_RUNTIME_DIR: root + "/runtime",
  XDG_CACHE_HOME: root + "/cache",
  SHELL: "/bin/sh",
});
fs.mkdirSync(root + "/config/herdr", { recursive: true });
fs.mkdirSync(root + "/runtime");
fs.writeFileSync(root + "/config/herdr/config.toml", "onboarding = false\n");
const log = fs.openSync(root + "/server.log", "w", 0o600),
  server = spawn(binary, ["--session", session, "server"], {
    cwd: root,
    env,
    stdio: ["ignore", log, log],
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function sockets(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sockets(p) : e.isSocket() ? [p] : [];
  });
}
function cli(args, { allowFailure = false } = {}) {
  assert.ok(
    env.HERDR_SOCKET_PATH?.startsWith(root + "/"),
    "No CLI mutation without the owned socket.",
  );
  const r = spawnSync(binary, ["--session", session, ...args], {
    env,
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
  if (!allowFailure) assert.equal(r.status, 0, r.stderr || r.stdout);
  let json;
  try {
    json = JSON.parse(r.stdout || r.stderr);
  } catch {
    // Syntax/version diagnostics need not be JSON.
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
async function until(fn, message) {
  for (let i = 0; i < 70; i++) {
    const r = fn();
    if (r) return r;
    await delay(100);
  }
  throw Error(message);
}
try {
  const socket = await until(() => {
    const available = sockets(root);
    return available.find((p) => p.endsWith("/herdr.sock")) || available[0];
  }, "Isolated server socket did not appear");
  env.HERDR_SOCKET_PATH = socket;
  const workspace = cli(["workspace", "create", "--cwd", root, "--no-focus"])
    .json.result;
  const pane = workspace.root_pane.pane_id;
  const fixture = fileURLToPath(
    new URL("../test/fixtures/ssh-foreground.mjs", import.meta.url),
  );
  const quote = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
  cli([
    "pane",
    "run",
    pane,
    `${quote(process.execPath)} ${quote(fixture)} ${quote(root)}`,
  ]);
  const agent = await until(() => {
    const r = cli(["agent", "get", pane], { allowFailure: true });
    return r.status === 0 &&
      ["idle", "done"].includes(r.json?.result?.agent?.agent_status)
      ? r.json.result.agent
      : null;
  }, "Foreground SSH transport was not recognized as ready Codex");
  assert.equal(agent.agent, "codex");
  const prompt = cli([
    "agent",
    "prompt",
    pane,
    "synthetic integration input",
    "--wait",
    "--timeout",
    "8000",
  ]);
  assert.equal(prompt.status, 0);
  cli([
    "pane",
    "report-agent-session",
    pane,
    "--source",
    "vultr.sandbox.fixture",
    "--agent",
    "codex",
    "--session-start-source",
    "plugin-worker",
    "--",
    "node",
    fileURLToPath(new URL("../src/action.mjs", import.meta.url)),
    "reconnect",
    "--worker",
    "00000000-0000-0000-0000-000000000000",
  ]);
  cli(["agent", "prompt", pane, "exit-fixture"]);
  await until(
    () =>
      cli([
        "pane",
        "read",
        pane,
        "--source",
        "recent-unwrapped",
        "--lines",
        "30",
      ]).stdout.includes("TRANSPORT_RETURNED_TO_DASHBOARD"),
    "Transport did not return",
  );
  const after = cli(["agent", "prompt", pane, "must not enter dashboard"], {
    allowFailure: true,
  });
  assert.notEqual(
    after.status,
    0,
    "A dashboard must not be an agent input target.",
  );
  cli(["pane", "send-keys", pane, "enter"]);
  await until(
    () =>
      cli([
        "pane",
        "read",
        pane,
        "--source",
        "recent-unwrapped",
        "--lines",
        "15",
      ]).stdout.includes("FOREGROUND_FIXTURE_CLOSED"),
    "Initial transport fixture did not finish",
  );
  // Link only into this owned server/config; this never updates the active installation.
  const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
  cli(["plugin", "link", pluginRoot]);
  const { runAction } = await import("../src/actions.mjs");
  const { openPluginPane } = await import("../src/herdr.mjs");
  let opened;
  const openedReceipt = await runAction(
    "connect-vultr",
    {},
    {
      env: {
        ...env,
        HERDR_BIN_PATH: binary,
        HERDR_PLUGIN_STATE_DIR: root + "/action-state",
        HERDR_AGENT: "codex",
      },
      context: { focused_pane_id: pane, workspace_cwd: root },
      openPane: (...args) => {
        opened = openPluginPane(...args);
        return opened;
      },
    },
  );
  const setupPane = JSON.parse(opened.stdout).result.plugin_pane.pane.pane_id;
  assert.equal(openedReceipt.paneId, setupPane);
  await until(
    () =>
      cli([
        "pane",
        "read",
        setupPane,
        "--source",
        "recent-unwrapped",
        "--lines",
        "20",
      ]).stdout.includes("Absolute path to 0600 API token file"),
    "Installed onboarding entrypoint did not start",
  );
  cli(["plugin", "pane", "focus", setupPane]);
  assert.notEqual(
    cli(["agent", "get", setupPane], { allowFailure: true }).status,
    0,
    "Onboarding must not inherit a coding-agent hint",
  );
  cli(["plugin", "pane", "close", setupPane]);

  const dashboard = fileURLToPath(
    new URL("../test/fixtures/worker-dashboard.mjs", import.meta.url),
  );
  cli([
    "pane",
    "run",
    pane,
    `${quote(process.execPath)} ${quote(dashboard)} ${quote(root)} ${quote(binary)}`,
  ]);
  await delay(300);
  await until(() => {
    const r = cli(["agent", "get", pane], { allowFailure: true });
    return (
      r.status === 0 &&
      ["idle", "done"].includes(r.json?.result?.agent?.agent_status)
    );
  }, "Actual worker runtime did not expose foreground agent");
  cli(["agent", "prompt", pane, "exit-fixture"]);
  await until(
    () =>
      cli([
        "pane",
        "read",
        pane,
        "--source",
        "recent-unwrapped",
        "--lines",
        "40",
      ]).stdout.includes("Vultr worker >"),
    "Actual worker did not remain as a dashboard after transport return",
  );
  const { Store } = await import("../src/state.mjs");
  const { requestWorker } = await import("../src/control.mjs");
  const store = new Store(path.join(root, "plugin-state")),
    id = "00000000-0000-0000-0000-000000000001";
  assert.equal(
    store.get(id).workerPane.paneId,
    pane,
    "Runtime must record its actual owned caller pane",
  );
  assert.notEqual(
    cli(["agent", "prompt", pane, "must not enter dashboard"], {
      allowFailure: true,
    }).status,
    0,
  );
  const previousTitle = cli(["pane", "list"]).json.result.panes.find(
    (p) => p.pane_id === pane,
  ).terminal_title;
  const reconnectReceipt = await requestWorker(store, id, "reconnect");
  assert.equal(reconnectReceipt.status, "queued");
  assert.ok(reconnectReceipt.requestId);
  await until(() => {
    const title = cli(["pane", "list"]).json.result.panes.find(
      (p) => p.pane_id === pane,
    ).terminal_title;
    return (
      title.startsWith("Transport fixture ready ") && title !== previousTitle
    );
  }, "Reconnected TUI did not initialize");
  await until(() => {
    const r = cli(["agent", "get", pane], { allowFailure: true });
    return (
      r.status === 0 &&
      ["idle", "done"].includes(r.json?.result?.agent?.agent_status)
    );
  }, "Same dashboard did not reconnect through private IPC");
  cli(["agent", "prompt", pane, "exit-fixture"]);
  await delay(200);
  await until(
    () =>
      cli([
        "pane",
        "read",
        pane,
        "--source",
        "recent-unwrapped",
        "--lines",
        "15",
      ]).stdout.includes("Vultr worker >"),
    "Second transport did not return",
  );
  assert.equal(
    store
      .get(id)
      .controlRequests.find(
        (request) => request.requestId === reconnectReceipt.requestId,
      ).status,
    "completed",
  );
  cli(["pane", "run", pane, "q"]);
  await until(
    () =>
      cli([
        "pane",
        "read",
        pane,
        "--source",
        "recent-unwrapped",
        "--lines",
        "15",
      ]).stdout.includes("WORKER_DASHBOARD_CLOSED"),
    "Dashboard did not close only on explicit q",
  );
  assert.equal(await requestWorker(store, id), null);
  console.log(
    JSON.stringify({
      status: "passed",
      herdr: spawnSync(binary, ["--version"], {
        encoding: "utf8",
      }).stdout.trim(),
      session,
      foregroundHint: true,
      promptWait: true,
      resumeMetadata: true,
      hintRevokedAfterExit: true,
      pluginLinked: true,
      installedOnboarding: true,
      explicitPluginFocus: true,
      persistentDashboard: true,
      ownerReconnect: true,
      providerConformance: false,
    }),
  );
} catch (error) {
  if (env.HERDR_SOCKET_PATH) {
    console.error(cli(["pane", "list"], { allowFailure: true }).stdout);
    for (const p of ["w1:p1"]) {
      console.error(
        cli(
          ["pane", "read", p, "--source", "recent-unwrapped", "--lines", "35"],
          { allowFailure: true },
        ).stdout,
      );
      console.error(
        cli(["pane", "process-info", "--pane", p], { allowFailure: true })
          .stdout,
      );
    }
  }
  throw error;
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    delay(5000),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
  fs.closeSync(log);
  fs.rmSync(root, { recursive: true, force: true });
}
