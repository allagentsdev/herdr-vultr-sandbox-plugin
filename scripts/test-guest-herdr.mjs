// Actual stock Herdr server/CLI; the agent process is explicitly synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/state.mjs";
const binary = process.env.VULTR_HERDR_TEST_BIN;
assert.ok(
  binary && path.isAbsolute(binary),
  "Set VULTR_HERDR_TEST_BIN to the official binary",
);
const root = fs.mkdtempSync("/tmp/vgh-"),
  state = root + "/state",
  source = root + "/source with ' quote",
  id = "00000000-0000-4000-8000-000000000001",
  helper = fileURLToPath(new URL("../src/guest-herdr.mjs", import.meta.url)),
  fixture = fileURLToPath(
    new URL("../test/fixtures/transport-screen.mjs", import.meta.url),
  );
fs.mkdirSync(state + "/tools", { recursive: true });
fs.mkdirSync(source);
fs.symlinkSync(binary, state + "/tools/herdr");
const q = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
fs.writeFileSync(
  state + "/launch.sh",
  `#!/bin/sh\nset -eu\ncd ${q(source)}\nprintf '%s\\n%s\\n' "$HOME" "$XDG_CONFIG_HOME" > ${q(state + "/agent-env")}\ntouch ${q(state + "/started")}\nprintf 'launch\\n' >> ${q(state + "/launches")}\nexec env HERDR_AGENT=codex ${q(process.execPath)} ${q(fixture)}\n`,
);
const log = [];
function call(op, allowFailure = false) {
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
    {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        HERDR_SOCKET_PATH: "/must-not-use/socket",
        HERDR_SESSION: "must-not-use",
        HOME: root + "/agent-home",
        XDG_CONFIG_HOME: root + "/agent-config",
      },
    },
  );
  log.push({ op, code: r.status, stdout: r.stdout, stderr: r.stderr });
  fs.writeFileSync(root + "/proof.json", JSON.stringify(log, null, 2));
  if (!allowFailure) assert.equal(r.status, 0, r.stderr);
  return { ...r, json: r.status === 0 ? JSON.parse(r.stdout) : null };
}
async function dashboard(mode) {
  const fixturePath = fileURLToPath(
    new URL("../test/fixtures/guest-dashboard.mjs", import.meta.url),
  );
  const driver = fileURLToPath(
    new URL("../test/fixtures/pty-dashboard.py", import.meta.url),
  );
  const child = spawn(
    "python3",
    [
      driver,
      mode,
      root + "/pty-" + mode + ".log",
      process.execPath,
      fixturePath,
      state,
      id,
      source,
    ],
    {
      env: {
        ...process.env,
        HOME: root + "/agent-home",
        XDG_CONFIG_HOME: root + "/agent-config",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "",
    didAttach = false;
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
    didAttach ||= stdout.includes('"event": "attached"');
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
  await until(() => didAttach);
  if (mode === "exit")
    native(["agent", "prompt", call("inspect").json.paneId, "exit-fixture"]);
  const result = await finished;
  fs.writeFileSync(
    root + "/pty-" + mode + ".json",
    JSON.stringify(result, null, 2),
  );
  assert.equal(result.code, 0, result.stdout + result.stderr);
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 60; i++) {
    const r = fn();
    if (r) return r;
    await pause(100);
  }
  throw Error("Native guest condition timed out");
}
function native(args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_")),
  );
  Object.assign(env, {
    HERDR_SESSION: "worker-" + id,
    HERDR_SOCKET_PATH: state + "/herdr.sock",
  });
  const r = spawnSync(binary, args, { env, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
try {
  const uninitialized = call("inspect").json;
  assert.equal(uninitialized.status, "unavailable");
  assert.ok(Number.isFinite(Date.parse(uninitialized.observedAt)));
  const first = call("ensure").json;
  assert.ok(first.workspaceId && first.paneId && first.terminalId);
  assert.equal(first.backend, "herdr");
  const active = await until(() => {
    const r = call("inspect").json;
    return (
      r.agent?.agent === "codex" &&
      ["idle", "done"].includes(r.agent.agent_status) &&
      r
    );
  });
  assert.ok(active.pid > 0);
  assert.ok(
    Number.isFinite(Date.parse(active.observedAt)),
    "Native runtime claims carry an observation time",
  );
  assert.equal(
    fs.readFileSync(state + "/agent-env", "utf8"),
    root + "/agent-home\n" + root + "/agent-config\n",
  );
  const again = call("ensure").json;
  assert.equal(again.terminalId, active.terminalId);
  assert.equal(again.pid, active.pid);
  assert.notEqual(call("restart", true).status, 0);
  fs.writeFileSync(state + "/resume-approved", "");
  call("resume");
  assert.equal(
    fs.existsSync(state + "/resume-approved"),
    false,
    "Live continuation consumes its one-use approval",
  );
  native([
    "agent",
    "prompt",
    active.paneId,
    "synthetic input",
    "--wait",
    "--timeout",
    "8000",
  ]);
  await dashboard("manual");
  const manualRecord = new Store(state + "/dashboard-state").get(id);
  assert.equal(manualRecord.transport.state, "detached");
  assert.ok(Number.isFinite(Date.parse(manualRecord.guestHerdr.observedAt)));
  assert.equal(call("inspect").json.pid, active.pid);
  await dashboard("exit");
  const exitRecord = new Store(state + "/dashboard-state").get(id);
  assert.equal(exitRecord.transport.state, "agent-exited");
  assert.equal(exitRecord.guestHerdr.terminalId, active.terminalId);
  await until(() => call("inspect").json.status === "agent-exited");
  const restarted = call("restart").json;
  assert.equal(restarted.terminalId, active.terminalId);
  await until(() => call("inspect").json.agent?.agent === "codex");
  assert.equal(
    fs
      .readFileSync(state + "/launches", "utf8")
      .trim()
      .split("\n").length,
    2,
  );
  call("quiesce");
  const offline = call("inspect").json;
  assert.equal(offline.status, "unavailable");
  assert.ok(Number.isFinite(Date.parse(offline.observedAt)));
  assert.notEqual(call("ensure", true).status, 0);
  assert.notEqual(call("ensure", true).status, 0);
  assert.notEqual(call("restart", true).status, 0);
  assert.equal(
    fs
      .readFileSync(state + "/launches", "utf8")
      .trim()
      .split("\n").length,
    2,
  );
  fs.writeFileSync(state + "/resume-approved", "");
  const resumed = call("resume").json;
  assert.ok(resumed.terminalId);
  await until(() => call("inspect").json.agent?.agent === "codex");
  assert.equal(
    fs
      .readFileSync(state + "/launches", "utf8")
      .trim()
      .split("\n").length,
    3,
  );
  assert.match(
    fs.readFileSync(state + "/herdr/config/herdr/config.toml", "utf8"),
    /resume_agents_on_restore = false/,
  );
  const persisted = call("ensure").json;
  native(["pane", "close", persisted.paneId]);
  const missingPane = call("inspect").json;
  assert.equal(missingPane.status, "unavailable");
  assert.equal(missingPane.pid, null);
  assert.equal(missingPane.shellPid, null);
  assert.equal(missingPane.agent, null);
  assert.ok(
    Date.parse(missingPane.observedAt) >= Date.parse(persisted.observedAt),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      nativeServer: true,
      syntheticAgent: true,
      liveProvider: false,
      root,
    }),
  );
} finally {
  call("quiesce", true);
  console.log("Native proof log: " + root + "/proof.json");
}
