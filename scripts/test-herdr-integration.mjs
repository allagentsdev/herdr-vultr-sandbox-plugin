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
const networkLog = path.join(root, "node-network-guard.jsonl"),
  networkGuard = path.join(root, "node-network-guard.mjs");
fs.writeFileSync(
  networkGuard,
  `import fs from "node:fs";
const file = ${JSON.stringify(networkLog)};
const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
fs.appendFileSync(file, JSON.stringify({
  entrypoint: process.argv[1], pid: process.pid,
  action: process.env.HERDR_PLUGIN_ACTION_ID,
  callerPaneId: context.focused_pane_id,
  workspaceId: context.workspace_id,
  callerCwd: context.focused_pane_cwd,
}) + "\\n");
globalThis.fetch = async () => {
  fs.appendFileSync(file, JSON.stringify({ unexpectedFetch: true, pid: process.pid }) + "\\n");
  throw new Error("Installed fixture forbids external provider requests");
};
`,
  { mode: 0o600 },
);
env.NODE_OPTIONS = `--import=${networkGuard}`;
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
  const source = path.join(root, "creation-source");
  fs.mkdirSync(source);
  assert.equal(spawnSync("git", ["init", "-q", source]).status, 0);
  fs.writeFileSync(
    path.join(source, "source.txt"),
    "harmless reviewed fixture\n",
  );
  const creationWorkspace = cli([
      "workspace",
      "create",
      "--cwd",
      source,
      "--no-focus",
    ]).json.result,
    sourcePane = creationWorkspace.root_pane.pane_id;
  const actionLogs = () =>
    cli(["plugin", "log", "list", "--plugin", "vultr.sandbox", "--limit", "20"])
      .json.result.logs;
  const guardRecords = () =>
    fs
      .readFileSync(networkLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const panes = () => cli(["pane", "list"]).json.result.panes;
  const installedActionContexts = [];
  const shellIdle = (paneId) => {
    const processInfo = cli(["pane", "process-info", "--pane", paneId]).json
      .result.process_info;
    return (
      processInfo.foreground_process_group_id === processInfo.shell_pid &&
      processInfo.foreground_processes.every(
        (process) => process.pid === processInfo.shell_pid,
      )
    );
  };
  async function invokeAction(action, callerPane = sourcePane) {
    const before = panes(),
      focused = before.filter((pane) => pane.focused),
      intended = before.find((pane) => pane.pane_id === callerPane),
      previous = new Set(actionLogs().map((log) => log.log_id)),
      previousGuardRecords = guardRecords().length;
    assert.equal(focused.length, 1);
    assert.equal(intended?.cwd, source);
    await until(
      () => shellIdle(callerPane),
      "Intended action source must be an idle shell",
    );
    try {
      cli(["workspace", "focus", intended.workspace_id]);
      assert.equal(panes().find((pane) => pane.focused)?.pane_id, callerPane);
      assert.equal(panes().find((pane) => pane.focused)?.cwd, source);
      cli([
        "pane",
        "run",
        callerPane,
        `${quote(binary)} --session ${quote(session)} plugin action invoke ${action} --plugin vultr.sandbox`,
      ]);
      const log = await until(() => {
        const fresh = actionLogs().filter(
          (entry) => !previous.has(entry.log_id) && entry.action_id === action,
        );
        assert.ok(
          fresh.length <= 1,
          "One invocation must have one exact action log",
        );
        const entry = fresh[0];
        return entry && ["succeeded", "failed"].includes(entry.status)
          ? entry
          : null;
      }, `Installed ${action} did not finish`);
      const callers = guardRecords()
        .slice(previousGuardRecords)
        .filter(
          (record) =>
            record.entrypoint?.endsWith("/src/action.mjs") &&
            record.action === action,
        );
      assert.equal(callers.length, 1);
      assert.equal(callers[0].callerPaneId, callerPane);
      assert.equal(callers[0].workspaceId, intended.workspace_id);
      assert.equal(callers[0].callerCwd, source);
      const records = log.stdout
        .split("\n")
        .filter((line) => line.startsWith("VULTR_RESULT "));
      assert.equal(records.length, 1, log.stdout || log.stderr);
      const receipt = JSON.parse(records[0].slice("VULTR_RESULT ".length));
      assert.equal(receipt.action, action);
      installedActionContexts.push({
        action,
        logId: log.log_id,
        callerPaneId: callers[0].callerPaneId,
        workspaceId: callers[0].workspaceId,
        callerCwd: callers[0].callerCwd,
        status: receipt.status,
        workerId: receipt.workerId ?? null,
        paneId: receipt.paneId ?? null,
      });
      return receipt;
    } finally {
      try {
        await until(
          () => shellIdle(callerPane),
          "Action CLI must return to its source shell",
        );
      } finally {
        cli(["workspace", "focus", focused[0].workspace_id]);
        assert.equal(
          panes().find((pane) => pane.focused)?.pane_id,
          focused[0].pane_id,
        );
      }
    }
  }
  const pluginConfig = cli([
    "plugin",
    "config-dir",
    "vultr.sandbox",
  ]).stdout.trim();
  assert.ok(pluginConfig.startsWith(root + path.sep));
  const { Store } = await import("../src/state.mjs");
  const installedList = async () => {
    const receipt = await invokeAction("list");
    assert.equal(receipt.status, "observed");
    return receipt.workers;
  };
  const initialSourcePane = panes().find((pane) => pane.pane_id === sourcePane);
  assert.equal(
    panes().filter(
      (pane) => pane.workspace_id === initialSourcePane.workspace_id,
    ).length,
    1,
  );
  const firstStart = await invokeAction("start-agent");
  assert.equal(firstStart.status, "opened", JSON.stringify(firstStart));
  assert.equal(firstStart.workerId, null);
  assert.ok(firstStart.paneId);
  await until(
    () =>
      cli([
        "pane",
        "read",
        firstStart.paneId,
        "--source",
        "recent-unwrapped",
        "--lines",
        "20",
      ]).stdout.includes("Absolute path to 0600 API token file"),
    "Missing-config Start did not open exact installed onboarding pane",
  );
  assert.equal((await installedList()).length, 0);
  cli(["plugin", "pane", "focus", firstStart.paneId]);
  assert.notEqual(
    cli(["agent", "get", firstStart.paneId], { allowFailure: true }).status,
    0,
    "Onboarding must not inherit a coding-agent hint",
  );
  cli(["plugin", "pane", "close", firstStart.paneId]);
  fs.mkdirSync(pluginConfig, { recursive: true, mode: 0o700 });
  const configFile = path.join(pluginConfig, "config.json"),
    dummyKey = path.join(root, "dummy-client"),
    config = {
      tokenFile: path.join(root, "dummy-token"),
      sshPrivateKey: dummyKey,
      sshPublicKey: path.join(root, "dummy-client.pub"),
      allowCandidateAgents: true,
    };
  fs.writeFileSync(configFile, "{", { mode: 0o600 });
  assert.equal((await invokeAction("start-agent")).code, "invalid_config");
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.equal(
    (await invokeAction("start-agent")).code,
    "credential_file_missing",
  );
  assert.equal((await installedList()).length, 0);
  fs.writeFileSync(
    config.tokenFile,
    "synthetic placeholder; no provider credential",
    { mode: 0o600 },
  );
  fs.writeFileSync(dummyKey, "synthetic placeholder; never used for SSH", {
    mode: 0o600,
  });
  function ownedWorkerFiles(dir, id) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory()
        ? ownedWorkerFiles(file, id)
        : entry.isFile() && entry.name === `${id}.json`
          ? [file]
          : [];
    });
  }
  const created = [];
  for (let i = 0; i < 2; i++) {
    const receipt = await invokeAction("new-worker");
    assert.equal(receipt.status, "opened", JSON.stringify(receipt));
    assert.ok(receipt.workerId && receipt.paneId);
    await until(
      () =>
        cli([
          "pane",
          "read",
          receipt.paneId,
          "--source",
          "recent-unwrapped",
          "--lines",
          "40",
        ]).stdout.includes("Type UPLOAD "),
      "Installed New worker did not reach exact upload approval",
    );
    const files = ownedWorkerFiles(env.XDG_STATE_HOME, receipt.workerId);
    assert.equal(files.length, 1);
    const installedStore = new Store(path.dirname(files[0])),
      record = installedStore.get(receipt.workerId),
      manifest = JSON.parse(
        fs.readFileSync(path.join(record.baseline, "manifest.json"), "utf8"),
      ),
      text = cli([
        "pane",
        "read",
        receipt.paneId,
        "--source",
        "recent-unwrapped",
        "--lines",
        "40",
      ]).stdout;
    assert.equal(record.workerPane.paneId, receipt.paneId);
    assert.equal(record.sourcePaneId, sourcePane);
    assert.equal(record.localRoot, source);
    assert.equal(record.phase, "upload-review");
    assert.equal(record.vm, null);
    assert.equal(record.pending, null);
    assert.equal(record.uploadApproval, undefined);
    assert.equal(record.guestBackend, "herdr");
    assert.equal(record.baselineDigest, manifest.digest);
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ["source.txt"],
    );
    assert.ok(text.includes(`/srv/herdr/workers/${record.id}/source`));
    assert.ok(text.includes(`Type UPLOAD ${manifest.digest}`));
    created.push({ receipt, record });
  }
  assert.notEqual(created[0].receipt.workerId, created[1].receipt.workerId);
  assert.notEqual(created[0].receipt.paneId, created[1].receipt.paneId);
  assert.notEqual(
    created[0].record.agentAdapter.codexHome,
    created[1].record.agentAdapter.codexHome,
  );
  assert.notEqual(created[0].record.baseline, created[1].record.baseline);
  const selection = await invokeAction("start-agent");
  assert.equal(selection.status, "selection_required");
  assert.equal(selection.workers.length, 2);
  assert.equal((await installedList()).length, 2);
  const observedGuardRecords = guardRecords();
  for (const entrypoint of ["action.mjs", "pane.mjs"])
    assert.ok(
      observedGuardRecords.some((record) =>
        record.entrypoint?.endsWith(`/src/${entrypoint}`),
      ),
      `Installed ${entrypoint} must inherit the network guard`,
    );
  assert.equal(
    observedGuardRecords.some((record) => record.unexpectedFetch),
    false,
  );
  for (const { receipt } of created)
    cli(["plugin", "pane", "close", receipt.paneId]);
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
  await until(
    () => store.get(id).transport.sessionMetadata === true,
    "Actual attached agent did not accept continuation metadata",
  );
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
      installedFirstStartSetup: true,
      installedTypedConfigFailures: true,
      installedIndependentWorkers: true,
      installedExactUploadReviews: true,
      installedCallerContext: true,
      installedActionContexts,
      providerRequestsBeforeApproval: 0,
      firstStartSetupReceipt: firstStart,
      independentWorkerReceipts: created.map(({ receipt, record }) => ({
        ...receipt,
        phase: record.phase,
        sourcePaneId: record.sourcePaneId,
        source: `/srv/herdr/workers/${record.id}/source`,
        home: record.agentAdapter.codexHome,
        digest: record.baselineDigest,
      })),
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
