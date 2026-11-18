import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { runAction } from "../src/actions.mjs";
import { pluginPaneArgs } from "../src/herdr.mjs";
import { runSync } from "../src/process.mjs";
import { temporary, repository, write } from "./helpers.mjs";
import { Store } from "../src/state.mjs";
import { newWorker } from "../src/mappings.mjs";
import { validateConfig } from "../src/config.mjs";
import { remotePaths } from "../src/ssh.mjs";
import { runWorker } from "../src/pane.mjs";

function creationFixture(t) {
  const directory = temporary(t),
    root = repository(t),
    env = {
      HERDR_PLUGIN_STATE_DIR: path.join(directory, "state"),
      HERDR_PLUGIN_CONFIG_DIR: path.join(directory, "config"),
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/synthetic/creation-socket",
    },
    context = {
      focused_pane_id: "w1:p1",
      focused_pane_cwd: root,
      workspace_cwd: root,
      workspace_id: "w1",
    },
    config = validateConfig({
      tokenFile: path.join(directory, "token"),
      sshPrivateKey: path.join(directory, "key"),
      sshPublicKey: path.join(directory, "key.pub"),
      allowCandidateAgents: true,
    }),
    store = new Store(env.HERDR_PLUGIN_STATE_DIR),
    opens = [];
  write(root, "source.txt", "review these exact bytes\n");
  return {
    directory,
    root,
    env,
    context,
    config,
    store,
    opens,
    options: {
      env,
      context,
      store,
      loadConfig: () => config,
      openPane: (...args) => {
        opens.push(args);
        return {
          stdout: JSON.stringify({
            result: {
              plugin_pane: { pane: { pane_id: `w1:p${opens.length + 1}` } },
            },
          }),
        };
      },
      requestWorker: async () => null,
    },
  };
}

test("explicit New worker creates an independent provisional worker beside ready A and preserves selected retries", async (t) => {
  const f = creationFixture(t),
    a = await newWorker(
      f.store,
      { root: f.root, cwd: f.root, sourcePaneId: "w1:p1" },
      f.context,
      f.config,
      f.env,
    );
  await f.store.update(a.id, (r) => ({
    ...r,
    phase: "ready",
    vm: { serverId: "synthetic-A" },
    workerPane: { paneId: "w1:p9" },
    uploadApproval: { digest: "a".repeat(64) },
  }));
  const before = f.store.get(a.id),
    opened = await runAction("new-worker", {}, f.options),
    b = f.store.get(opened.workerId);
  assert.deepEqual(f.store.get(a.id), before);
  assert.notEqual(b.id, a.id);
  assert.equal(b.phase, "provisional");
  assert.equal(b.vm, null);
  assert.equal(b.guestBackend, "herdr");
  assert.equal(b.uploadApproval, undefined);
  assert.equal(opened.paneId, "w1:p2");
  assert.equal(f.opens[0][2].env.VULTR_WORKER, b.id);
  assert.equal(f.opens[0][2].env.VULTR_ACTION, "new-worker");
  assert.equal(remotePaths(b).source, `/srv/herdr/workers/${b.id}/source`);
  assert.equal(
    b.agentAdapter.codexHome,
    `/var/lib/herdr/workers/${b.id}/agent-home`,
  );
  assert.notEqual(b.agentAdapter.codexHome, a.agentAdapter.codexHome);
  assert.notEqual(f.store.artifacts(b.id), f.store.artifacts(a.id));
  f.config.region = "lhr";
  assert.equal(f.store.get(b.id).config.region, "syd");
  for (const action of ["start-agent", "reconnect"]) {
    if (action === "start-agent")
      assert.equal(
        (await runAction(action, {}, f.options)).status,
        "selection_required",
      );
    for (const id of [a.id, b.id]) {
      const retry = await runAction(action, { worker: id }, f.options);
      assert.equal(retry.workerId, id);
    }
  }
  assert.equal(f.store.list().length, 2);
});

test("each provisional New worker reaches exact upload review before any provider operation", async (t) => {
  const f = creationFixture(t);
  let providerCalls = 0;
  for (let i = 0; i < 2; i++) {
    const opened = await runAction("new-worker", {}, f.options),
      id = opened.workerId;
    await runWorker({
      store: f.store,
      id,
      initialAction: "new-worker",
      env: f.env,
      services: {
        life: {
          create: () => {
            providerCalls++;
            throw new Error(
              "Synthetic provider must not be called before approval",
            );
          },
        },
      },
      resolvePane: () => opened.paneId,
      menuInput: async () => "q",
      display: () => {},
    });
    const r = f.store.get(id);
    assert.equal(r.phase, "upload-review");
    assert.equal(r.vm, null);
    assert.equal(r.uploadApproval, undefined);
    assert.match(r.baselineDigest, /^[a-f0-9]{64}$/);
    assert.ok(r.baseline.startsWith(f.store.artifacts(id) + path.sep));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(r.baseline, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.digest, r.baselineDigest);
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ["source.txt"],
    );
    assert.equal(providerCalls, 0);
  }
  assert.equal(f.store.list().length, 2);
});

test("New worker rejects an existing-worker selector without opening or allocating", async (t) => {
  const f = creationFixture(t);
  await assert.rejects(
    runAction("new-worker", { worker: "chosen-worker" }, f.options),
    { code: "invalid_action_options" },
  );
  assert.equal(f.opens.length, 0);
  assert.equal(f.store.list().length, 0);
});

test("New worker sourced from A dashboard leaves ordinary Start and Reconnect attached to A", async (t) => {
  const f = creationFixture(t),
    a = await newWorker(
      f.store,
      { root: f.root, cwd: f.root, sourcePaneId: "w1:p1" },
      f.context,
      f.config,
      f.env,
    );
  await f.store.update(a.id, (r) => ({
    ...r,
    phase: "ready",
    workerPane: { paneId: "w1:p9" },
  }));
  const context = { ...f.context, focused_pane_id: "w1:p9" },
    options = { ...f.options, context },
    b = await runAction("new-worker", {}, options);
  assert.notEqual(b.workerId, a.id);
  assert.equal(f.store.get(b.workerId).sourcePaneId, "w1:p9");
  for (const action of ["start-agent", "reconnect"])
    assert.equal((await runAction(action, {}, options)).workerId, a.id);
  assert.equal(f.store.list().length, 2);
});

test("unknown New worker pane creation retains its UUID for explicit retry without blind allocation", async (t) => {
  const f = creationFixture(t);
  await assert.rejects(
    runAction(
      "new-worker",
      {},
      { ...f.options, openPane: () => ({ stdout: "unknown outcome" }) },
    ),
    { code: "pane_open_unknown" },
  );
  const [worker] = f.store.list();
  assert.equal(worker.phase, "provisional");
  assert.equal(worker.vm, null);
  for (const action of ["start-agent", "reconnect"]) {
    const result = await runAction(action, { worker: worker.id }, f.options);
    assert.equal(result.workerId, worker.id);
  }
  assert.equal(f.store.list().length, 1);
});

test("existing recoverable worker uses its recorded configuration when host config is missing", async (t) => {
  const f = creationFixture(t),
    a = await newWorker(
      f.store,
      { root: f.root, cwd: f.root, sourcePaneId: "w1:p1" },
      f.context,
      f.config,
      f.env,
    );
  const options = {
    ...f.options,
    loadConfig: () =>
      assert.fail("Existing worker configuration must be retained"),
  };
  for (const action of ["start-agent", "reconnect"])
    assert.equal((await runAction(action, {}, options)).workerId, a.id);
  assert.equal(f.store.list().length, 1);
});

test("first Start and New worker route only missing config.json into exact onboarding with no mapping", async (t) => {
  for (const action of ["start-agent", "new-worker"]) {
    const f = creationFixture(t);
    delete f.options.loadConfig;
    const result = await runAction(action, {}, f.options);
    assert.deepEqual(result, {
      status: "opened",
      workerId: null,
      paneId: "w1:p2",
    });
    assert.equal(f.opens[0][0], "onboarding");
    assert.equal(f.opens[0][2].env.VULTR_ACTION, "connect-vultr");
    assert.equal(f.store.list().length, 0);
  }
});

test("setup routing requires both ENOENT and the exact host config path", async (t) => {
  const f = creationFixture(t);
  for (const error of [
    Object.assign(new Error("synthetic missing credential"), {
      code: "ENOENT",
      path: f.config.sshPrivateKey,
    }),
    Object.assign(new Error("synthetic denied configuration"), {
      code: "EACCES",
      path: path.join(f.env.HERDR_PLUGIN_CONFIG_DIR, "config.json"),
    }),
  ]) {
    await assert.rejects(
      runAction(
        "start-agent",
        {},
        {
          ...f.options,
          loadConfig: () => {
            throw error;
          },
        },
      ),
      (actual) => actual === error,
    );
  }
  assert.equal(f.opens.length, 0);
  assert.equal(f.store.list().length, 0);
});

test("creation preserves typed malformed, invalid, private-file and missing-key failures instead of setup", async (t) => {
  for (const action of ["start-agent", "new-worker"]) {
    for (const kind of [
      "malformed",
      "invalid",
      "required",
      "permissions",
      "symlink",
      "key",
    ]) {
      await t.test(`${action}: ${kind}`, async (t) => {
        const f = creationFixture(t);
        delete f.options.loadConfig;
        const configFile = path.join(
          f.env.HERDR_PLUGIN_CONFIG_DIR,
          "config.json",
        );
        fs.mkdirSync(f.env.HERDR_PLUGIN_CONFIG_DIR);
        const config =
          kind === "invalid"
            ? { unknown: true }
            : kind === "required"
              ? {}
              : f.config;
        fs.writeFileSync(
          configFile,
          kind === "malformed" ? "{" : JSON.stringify(config),
          { mode: 0o600 },
        );
        const code = ["malformed", "invalid"].includes(kind)
          ? "invalid_config"
          : kind === "required"
            ? "config_required"
            : kind === "key"
              ? "credential_file_missing"
              : "private_file_required";
        if (kind === "permissions") fs.chmodSync(configFile, 0o644);
        if (kind === "symlink") {
          fs.renameSync(configFile, configFile + ".target");
          fs.symlinkSync(configFile + ".target", configFile);
        }
        await assert.rejects(runAction(action, {}, f.options), { code });
        assert.equal(f.opens.length, 0);
        assert.equal(f.store.list().length, 0);
      });
    }
  }
});

test("normal positional CLI and installed manifest expose New worker with truthful opened result", (t) => {
  const f = creationFixture(t),
    pluginRoot = fileURLToPath(new URL("../", import.meta.url)),
    fake = path.join(f.directory, "herdr");
  fs.mkdirSync(f.env.HERDR_PLUGIN_CONFIG_DIR);
  fs.writeFileSync(
    path.join(f.env.HERDR_PLUGIN_CONFIG_DIR, "config.json"),
    JSON.stringify(f.config),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    f.config.sshPrivateKey,
    "synthetic placeholder; never used for SSH",
    { mode: 0o600 },
  );
  fs.writeFileSync(
    fake,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"result":{"plugin_pane":{"pane":{"pane_id":"w1:p8"}}}}\'\n',
    { mode: 0o700 },
  );
  const manifest = TOML.parse(
      fs.readFileSync(path.join(pluginRoot, "herdr-plugin.toml"), "utf8"),
    ),
    action = manifest.actions.find((item) => item.id === "new-worker");
  assert.ok(action);
  for (const [command, args, extra] of [
    [
      process.execPath,
      [path.join(pluginRoot, "src/action.mjs"), "new-worker"],
      {},
    ],
    [
      action.command[0],
      action.command.slice(1),
      { HERDR_PLUGIN_ACTION_ID: "new-worker" },
    ],
  ]) {
    const result = runSync(command, args, {
      cwd: f.directory,
      env: {
        ...process.env,
        ...f.env,
        ...extra,
        HERDR_PLUGIN_ROOT: pluginRoot,
        HERDR_BIN_PATH: fake,
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(f.context),
      },
    });
    const receipt = JSON.parse(
      result.stdout.trim().replace(/^VULTR_RESULT /, ""),
    );
    assert.equal(receipt.action, "new-worker");
    assert.equal(receipt.status, "opened");
    assert.equal(receipt.paneId, "w1:p8");
    assert.equal(f.store.get(receipt.workerId).phase, "provisional");
  }
  assert.equal(f.store.list().length, 2);
});
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
