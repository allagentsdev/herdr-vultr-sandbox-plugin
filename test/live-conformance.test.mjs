import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store } from "../src/state.mjs";
import { temporary } from "./helpers.mjs";

const script = fileURLToPath(
  new URL("../scripts/live-conformance.mjs", import.meta.url),
);
const preload = fileURLToPath(
  new URL("./fixtures/live-observation.mjs", import.meta.url),
);
const marker = "OMITTED_OBSERVATION_METADATA_";
async function observe(t, { legacy = false, status = "detached" } = {}) {
  const root = temporary(t),
    store = new Store(path.join(root, "state")),
    id = randomUUID(),
    tokenFile = path.join(root, "synthetic-key"),
    fixtureFile = path.join(root, "fixture.json");
  fs.writeFileSync(tokenFile, "synthetic-fixture-only", { mode: 0o600 });
  await store.create({
    id,
    namespace: "synthetic-observation",
    localRoot: root,
    guestBackend: legacy ? undefined : "herdr",
    phase: "ready",
    config: { tokenFile },
    vm: { serverId: "synthetic-server", hostKey: "synthetic-pin" },
  });
  const session = {
    status,
    workspaceId: "w7",
    paneId: "w7:p3",
    terminalId: "term_observed",
    session: marker + "SESSION_NAME",
    cwd: marker + "OUTER_CWD",
    futureField: marker + "FUTURE_FIELD",
    agent: {
      agent: marker + "AGENT",
      agent_status: "unknown",
      terminal_id: "term_observed",
      workspace_id: "w7",
      tab_id: "w7:t2",
      pane_id: "w7:p3",
      focused: false,
      revision: 1,
      interactive_ready: true,
      tokens: { custom: marker + "TOKEN" },
      state_labels: { custom: marker + "STATE_LABEL" },
      cwd: marker + "CWD",
      foreground_cwd: marker + "FOREGROUND_CWD",
      title: marker + "TITLE",
      terminal_title: marker + "TERMINAL_TITLE",
      terminal_title_stripped: marker + "STRIPPED_TITLE",
      name: marker + "NAME",
      display_agent: marker + "DISPLAY_AGENT",
      agent_session: {
        source: marker + "SESSION_SOURCE",
        agent: marker + "SESSION_AGENT",
        kind: "id",
        value: marker + "SESSION_VALUE",
      },
    },
  };
  fs.writeFileSync(
    fixtureFile,
    JSON.stringify({
      server: {
        id: "synthetic-server",
        powerState: "running",
        volumes: [],
        tags: ["herdr-plugin=vultr.sandbox", `herdr-worker=${id}`],
      },
      session,
      probeOutput: marker + "SOURCE_PROBE",
      legacyOutput: "%4 321 0 0",
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      script,
      "--allow-live-conformance",
      "--dedicated-account",
      "--worker",
      id,
      "--server",
      "synthetic-server",
    ],
    {
      env: {
        ...process.env,
        HERDR_PLUGIN_STATE_DIR: store.directory,
        VULTR_OBSERVATION_FIXTURE: fixtureFile,
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  return { result, id };
}

test("live observation emits genuine status and native IDs without free-form metadata", async (t) => {
  const { result, id } = await observe(t);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "observed");
  assert.equal(output.workerId, id);
  assert.equal(output.serverId, "synthetic-server");
  assert.equal(output.providerStatus, "running");
  assert.equal(output.guestBackend, "herdr");
  assert.deepEqual(output.remoteSession, {
    status: "detached",
    workspaceId: "w7",
    paneId: "w7:p3",
    terminalId: "term_observed",
  });
  assert.equal((result.stdout + result.stderr).includes(marker), false);
});

test("live observation retains legacy pane identity without inventing native IDs", async (t) => {
  const { result } = await observe(t, { legacy: true });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.guestBackend, "tmux");
  assert.deepEqual(output.remoteSession, {
    status: "detached",
    workspaceId: null,
    paneId: "%4",
    terminalId: null,
  });
});

test("exited observations cannot claim a running worker from agent readiness metadata", async (t) => {
  const { result } = await observe(t, { status: "agent-exited" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /"status":"failed"/);
  assert.equal(result.stdout.includes('"status":"observed"'), false);
  assert.equal((result.stdout + result.stderr).includes(marker), false);
});
