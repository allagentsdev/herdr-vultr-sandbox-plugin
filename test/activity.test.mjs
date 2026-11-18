import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Remote } from "../src/remote.mjs";
import { validateConfig } from "../src/config.mjs";
import { resolveAdapter, adapterCommands } from "../src/adapters.mjs";

function fixture() {
  const id = randomUUID();
  const saved = {
    backend: "herdr",
    workerId: id,
    session: "worker-" + id,
    workspaceId: "w1",
    paneId: "w1:p2",
    terminalId: "term_owned",
  };
  const r = {
    id,
    guestBackend: "herdr",
    guestHerdr: saved,
    vm: { serverId: randomUUID() },
    config: { adapter: {} },
    agentAdapter: { capabilities: { herdrDetectionKind: "codex" } },
  };
  const f = {
    r,
    commands: [],
    observed: {
      ...saved,
      status: "detached",
      pid: 123,
      shellPid: 100,
      agent: {
        terminal_id: saved.terminalId,
        pane_id: saved.paneId,
        agent: "codex",
        agent_status: "idle",
        interactive_ready: true,
        state_change_seq: 10,
      },
    },
  };
  f.remote = new Remote({
    exec: (_, command) => {
      f.commands.push(command);
      return { stdout: JSON.stringify(f.observed) };
    },
  });
  return f;
}

test("activity uses existing Vultr helper inspect and matching persisted worker, session, terminal, pane and agent", () => {
  const f = fixture(),
    initial = f.remote.activity(f.r);
  assert.equal(initial.state, "idle");
  assert.match(initial.token, /^[a-f0-9]{64}$/);
  assert.match(f.commands[0], /guest-herdr.mjs' 'inspect'/);
  assert.doesNotMatch(f.commands[0], /agent get|herdr\/herdr.sock/);
  assert.equal(f.remote.activity(f.r).token, initial.token);
  f.observed.agent.state_change_seq++;
  assert.notEqual(f.remote.activity(f.r).token, initial.token);
  for (const field of [
    "workerId",
    "session",
    "workspaceId",
    "paneId",
    "terminalId",
  ]) {
    const good = f.observed[field];
    f.observed[field] = "unrelated";
    assert.equal(f.remote.activity(f.r).state, "unknown");
    f.observed[field] = good;
  }
  for (const changed of [
    { terminal_id: "other" },
    { pane_id: "other" },
    { agent: "other" },
    { interactive_ready: false },
    { launch_pending: true },
    { screen_detection_skipped: true },
    { state_change_seq: "10" },
    { state_change_seq: -1 },
    { agent_status: "unknown" },
  ]) {
    const good = f.observed.agent;
    f.observed.agent = { ...good, ...changed };
    assert.equal(f.remote.activity(f.r).state, "unknown");
    f.observed.agent = good;
  }
  for (const state of ["working", "blocked"]) {
    f.observed.agent.agent_status = state;
    assert.deepEqual(f.remote.activity(f.r), { state });
  }
});

test("confirmed foreground exit has a bounded identity token; unavailable transport or detached silence never implies idle", () => {
  const f = fixture();
  f.observed.agent = null;
  assert.deepEqual(f.remote.activity(f.r), { state: "unknown" });
  f.observed.status = "agent-exited";
  f.observed.pid = null;
  assert.equal(f.remote.activity(f.r).state, "idle");
  f.observed.shellPid = null;
  assert.equal(f.remote.activity(f.r).state, "unknown");
  f.observed.status = "unavailable";
  assert.equal(f.remote.activity(f.r).state, "unknown");
  f.remote.ssh.exec = () => {
    throw Error("SSH/auth unavailable");
  };
  assert.equal(f.remote.activity(f.r).state, "unknown");
});

test("legacy tmux stays protected without a probe; explicit application probe takes precedence and hashes bounded tokens", () => {
  const f = fixture();
  f.r.guestBackend = "tmux";
  assert.equal(f.remote.activity(f.r).state, "unknown");
  assert.equal(f.commands.length, 0);
  f.r.config.adapter.activity = "application-aware-probe";
  f.remote.ssh.exec = (_, command, options) => {
    assert.equal(command, "application-aware-probe");
    assert.equal(options.maxBuffer, 4096);
    return {
      stdout: JSON.stringify({
        state: "idle",
        token: "private arbitrary marker",
      }),
    };
  };
  const activity = f.remote.activity(f.r);
  assert.match(activity.token, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(activity).includes("private arbitrary"));
  f.r.guestBackend = "herdr";
  f.observed.status = "agent-exited";
  f.observed.pid = null;
  for (const value of [
    { state: "idle", token: "x".repeat(257) },
    { state: "idle", token: "" },
    null,
    [],
  ]) {
    f.remote.ssh.exec = () => ({ stdout: JSON.stringify(value) });
    assert.equal(f.remote.activity(f.r).state, "unknown");
  }
  f.remote.ssh.exec = () => {
    throw Error("probe unavailable");
  };
  assert.equal(f.remote.activity(f.r).state, "unknown");
});

test("application probe survives adapter resolution and command snapshotting", () => {
  const config = validateConfig({
    agentKind: "codex",
    allowCandidateAgents: true,
    adapter: { activity: "application-probe" },
  });
  assert.equal(
    adapterCommands(resolveAdapter(config)).activity,
    "application-probe",
  );
});
