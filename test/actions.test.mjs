import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { runAction } from "../src/actions.mjs";
import { pluginPaneArgs } from "../src/herdr.mjs";
import { runSync } from "../src/process.mjs";
import { temporary } from "./helpers.mjs";
test("action launcher requires caller and targets supplied source even when another pane is focused", async (t) => {
  await assert.rejects(runAction("reconnect", {}, { env: {}, context: {} }), {
    code: "caller_required",
  });
  const opens = [];
  await runAction(
    "reconnect",
    {},
    {
      env: { HERDR_PLUGIN_STATE_DIR: temporary(t), HERDR_PANE_ID: "w1:p1" },
      context: { focused_pane_id: "w1:p2" },
      openPane: (...args) => {
        opens.push(args);
        return {
          stdout: JSON.stringify({
            result: { plugin_pane: { pane: { pane_id: "w1:p9" } } },
          }),
        };
      },
    },
  );
  assert.equal(opens[0][2].targetPaneId, "w1:p2");
  const args = pluginPaneArgs(...opens[0]);
  assert.equal(args[args.indexOf("--target-pane") + 1], "w1:p2");
});
test("installed manifest action runs from an unrelated cwd using absolute plugin-root entrypoint", (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    dir = temporary(t),
    fake = path.join(dir, "herdr");
  fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const manifest = TOML.parse(
    fs.readFileSync(path.join(root, "herdr-plugin.toml"), "utf8"),
  );
  const [command, ...args] = manifest.actions.find(
    (a) => a.id === "status",
  ).command;
  const result = runSync(command, args, {
    cwd: dir,
    env: {
      ...process.env,
      HERDR_PLUGIN_ROOT: root,
      HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"),
      HERDR_PLUGIN_ACTION_ID: "status",
      HERDR_PLUGIN_CONTEXT_JSON: '{"focused_pane_id":"w1:p1"}',
      HERDR_BIN_PATH: fake,
    },
  });
  assert.match(result.stdout, /VULTR_RESULT.*selection_required/);
});

test("read-only mapping diagnostics do not open panes and actions reuse the live owner instead of spawning another worker", async (t) => {
  const { Store, namespace } = await import("../src/state.mjs");
  const { randomUUID } = await import("node:crypto");
  const store = new Store(temporary(t)),
    env = { HERDR_PANE_ID: "w1:p1" },
    id = randomUUID(),
    context = { focused_pane_id: "w1:p1" };
  await store.create({
    id,
    namespace: namespace(env),
    sourcePaneId: "w1:p1",
    localRoot: temporary(t),
    phase: "ready",
    vm: { serverId: 42 },
    config: {
      adapter: { launch: "codex", resume: "codex resume", authCheck: "true" },
    },
  });
  const opens = [],
    focus = [],
    options = {
      env,
      context,
      store,
      openPane: (...args) => {
        opens.push(args);
        return {
          stdout: JSON.stringify({
            result: { plugin_pane: { pane: { pane_id: "w1:p9" } } },
          }),
        };
      },
      requestWorker: async () => ({ status: "busy", paneId: "w1:p2" }),
      focusPane: (id) => focus.push(id),
    };
  assert.equal((await runAction("info", {}, options)).serverId, 42);
  assert.equal((await runAction("list", {}, options)).workers.length, 1);
  const result = await runAction("start-agent", {}, options);
  assert.equal(result.workerId, id);
  assert.equal(result.status, "busy");
  assert.deepEqual(focus, ["w1:p2"]);
  assert.equal(opens.length, 0);
  assert.equal(store.list().length, 1);
});
test("invalid startup arguments still produce a first machine-readable result without opening a pane", () => {
  const file = fileURLToPath(new URL("../src/action.mjs", import.meta.url));
  const r = runSync(process.execPath, [file, "--unsupported"], {
    check: false,
    env: { ...process.env, HERDR_PLUGIN_ACTION_ID: "status" },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout.split("\n")[0], /^VULTR_RESULT .*"status":"failed"/);
});

test("ambiguous same-source mappings require selection rather than silently creating a third worker", async (t) => {
  const { Store, namespace } = await import("../src/state.mjs");
  const { randomUUID } = await import("node:crypto");
  const { repository } = await import("./helpers.mjs");
  const store = new Store(temporary(t)),
    root = repository(t),
    env = { HERDR_PANE_ID: "w1:p1" },
    context = { focused_pane_id: "w1:p1", workspace_cwd: root };
  for (let i = 0; i < 2; i++)
    await store.create({
      id: randomUUID(),
      namespace: namespace(env),
      sourcePaneId: "w1:p1",
      localRoot: root,
      phase: "ready",
      config: { adapter: { launch: "codex" } },
    });
  const result = await runAction(
    "start-agent",
    {},
    {
      env,
      context,
      store,
      loadConfig: () => assert.fail("Must not load new worker credentials"),
    },
  );
  assert.equal(result.status, "selection_required");
  assert.equal(store.list().length, 2);
});

test("missing startup dependencies retain the first result marker without exposing arbitrary errors", (t) => {
  const dir = temporary(t);
  fs.copyFileSync(
    fileURLToPath(new URL("../src/action.mjs", import.meta.url)),
    path.join(dir, "action.mjs"),
  );
  const r = runSync(
    process.execPath,
    [path.join(dir, "action.mjs"), "status"],
    { check: false },
  );
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^VULTR_RESULT .*"code":"startup_failed"/);
});

test("setup opens independently of a live mapped worker and clears inherited agent hints in the dashboard environment", async (t) => {
  const { Store, namespace } = await import("../src/state.mjs");
  const { randomUUID } = await import("node:crypto");
  const store = new Store(temporary(t)),
    env = { HERDR_PANE_ID: "w1:p1" },
    id = randomUUID();
  await store.create({
    id,
    namespace: namespace(env),
    sourcePaneId: "w1:p1",
    localRoot: temporary(t),
    config: {},
  });
  const opens = [];
  const result = await runAction(
    "connect-vultr",
    {},
    {
      store,
      env,
      context: { focused_pane_id: "w1:p1" },
      openPane: (...args) => {
        opens.push(args);
        return {
          stdout: JSON.stringify({
            result: { plugin_pane: { pane: { pane_id: "w1:p9" } } },
          }),
        };
      },
      requestWorker: () =>
        assert.fail("Provider setup must not enter worker control"),
    },
  );
  assert.equal(result.status, "opened");
  assert.equal(opens[0][0], "onboarding");
  assert.equal(opens[0][2].env.HERDR_AGENT, "");
});

test("a timed-out live owner is focused as busy without opening another pane", async (t) => {
  const { Store, namespace } = await import("../src/state.mjs");
  const { randomUUID } = await import("node:crypto");
  const { serveWorker } = await import("../src/control.mjs");
  const store = new Store(temporary(t)),
    env = { HERDR_PANE_ID: "w1:p1" },
    id = randomUUID();
  await store.create({
    id,
    namespace: namespace(env),
    sourcePaneId: "w1:p1",
    localRoot: temporary(t),
    workerPane: { paneId: "w1:p2" },
    config: {},
  });
  const close = await serveWorker(store, id, () => ({ status: "alive" })),
    focused = [];
  try {
    const r = await runAction(
      "reconnect",
      {},
      {
        store,
        env,
        context: { focused_pane_id: "w1:p1" },
        requestWorker: async () => null,
        openPane: () => assert.fail("Live owner must not be replaced"),
        focusPane: (id) => focused.push(id),
      },
    );
    assert.equal(r.status, "busy");
    assert.deepEqual(focused, ["w1:p2"]);
  } finally {
    await close();
  }
});

test("canonical and symlinked worker entrypoints run from another cwd while imports stay inert", (t) => {
  const dir = temporary(t),
    target = fileURLToPath(new URL("../src/pane.mjs", import.meta.url)),
    link = path.join(dir, "worker.mjs");
  fs.symlinkSync(target, link);
  fs.symlinkSync(path.dirname(target), path.join(dir, "source"), "dir");
  for (const args of [
    [target],
    [link],
    ["--preserve-symlinks-main", path.join(dir, "source/pane.mjs")],
  ]) {
    const r = runSync(process.execPath, args, {
      cwd: dir,
      env: { PATH: process.env.PATH },
      check: false,
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /missing_plugin_state_dir/);
  }
  const r = runSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(new URL("../src/pane.mjs", import.meta.url).href)})`,
    ],
    { cwd: dir, env: { PATH: process.env.PATH } },
  );
  assert.equal(r.stdout, "");
});

test("opened receipts identify the exact Herdr pane and queued receipts retain their request ID", async (t) => {
  const { Store, namespace } = await import("../src/state.mjs");
  const { randomUUID } = await import("node:crypto");
  const store = new Store(temporary(t)),
    env = { HERDR_PANE_ID: "w1:p1" },
    context = { focused_pane_id: "w1:p1" };
  const options = {
    store,
    env,
    context,
    openPane: () => ({
      stdout: JSON.stringify({
        result: { plugin_pane: { pane: { pane_id: "w1:p9" } } },
      }),
    }),
  };
  assert.equal((await runAction("connect-vultr", {}, options)).paneId, "w1:p9");
  assert.equal((await runAction("reconnect", {}, options)).paneId, "w1:p9");
  const id = randomUUID();
  await store.create({
    id,
    namespace: namespace(env),
    sourcePaneId: "w1:p1",
    localRoot: temporary(t),
    config: {},
  });
  const queued = await runAction(
    "reconnect",
    { worker: id },
    {
      ...options,
      requestWorker: async () => ({
        status: "queued",
        paneId: "w1:p9",
        requestId: "request-123",
      }),
      focusPane: () => {},
    },
  );
  assert.equal(queued.requestId, "request-123");
});
