import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Remote } from "../src/remote.mjs";
import { runSync } from "../src/process.mjs";
import { captureSnapshot, readRegular } from "../src/manifest.mjs";
import { validateConfig } from "../src/config.mjs";
import { temporary, repository, write } from "./helpers.mjs";
const transfer = fileURLToPath(
  new URL("../src/remote-transfer.mjs", import.meta.url),
);
test("transfer runs actual remote receiver with exact binary bytes and rejects duplicate destination or escaping paths", (t) => {
  const repo = repository(t),
    dir = temporary(t),
    config = validateConfig({});
  write(repo, "file", Buffer.from([0, 255, 2]));
  const snap = captureSnapshot(repo, config, path.join(dir, "baseline"));
  const payload = {
    digest: snap.digest,
    files: snap.files.map((f) => ({
      ...f,
      bytes: readRegular(
        path.join(snap.directory, "files"),
        f.path,
        config.maxFileBytes,
      ).bytes.toString("base64"),
    })),
  };
  const root = path.join(dir, "remote");
  const send = (input, temp) =>
    runSync(
      process.execPath,
      [transfer, "upload", root, path.join(dir, temp), JSON.stringify(config)],
      { input: JSON.stringify(input), check: false },
    );
  assert.equal(send(payload, "upload").status, 0);
  assert.deepEqual(
    fs.readFileSync(path.join(root, "file")),
    Buffer.from([0, 255, 2]),
  );
  assert.notEqual(send(payload, "again").status, 0);
  fs.rmSync(root, { recursive: true });
  assert.notEqual(
    send(
      {
        digest: "bad",
        files: [{ path: "../outside", bytes: "YmFk", mode: "100644" }],
      },
      "escape",
    ).status,
    0,
  );
  assert.equal(fs.existsSync(path.join(dir, "outside")), false);
});
test("remote restore checks persisted identity, exact source digest, auth and service hook before approval", async () => {
  const checkpoint = {
    workerId: "worker",
    sourceDigest: "base",
    currentSourceDigest: "current",
    at: "time",
  };
  const r = {
    id: "worker",
    snapshot: { checkpoint },
    config: validateConfig({
      adapter: { authCheck: "agent-login-status", restart: "restart-services" },
    }),
  };
  const commands = [];
  const remote = new Remote({
    exec(record, command) {
      commands.push(command);
      if (command.includes("identity.json"))
        return { stdout: JSON.stringify({ workerId: "worker" }) };
      if (command.includes("checkpoint.json"))
        return { stdout: JSON.stringify(checkpoint) };
      if (command.startsWith("node "))
        return { stdout: JSON.stringify({ digest: "current" }) };
      return { stdout: "" };
    },
  });
  await remote.verifyResume(r);
  assert.match(commands.at(-1), /agent-login-status/);
  assert.match(commands.at(-1), /restart-services/);
  assert.match(commands.at(-1), /resume-approved/);
  r.snapshot.checkpoint = { ...checkpoint, currentSourceDigest: "wrong" };
  await assert.rejects(remote.verifyResume(r), { code: "restore_mismatch" });
});

test("allocated worker resume verifies identity and auth without requiring its old snapshot source", async () => {
  const r = {
    id: "worker",
    snapshot: { checkpoint: { currentSourceDigest: "old-source" } },
    config: validateConfig({
      adapter: { authCheck: "agent-login-status", restart: "restart-services" },
    }),
  };
  const commands = [];
  const remote = new Remote({
    exec(record, command) {
      commands.push(command);
      if (command.includes("identity.json"))
        return { stdout: JSON.stringify({ workerId: "worker" }) };
      return { stdout: "" };
    },
  });
  await remote.activate(r);
  assert.equal(
    commands.some((command) => command.startsWith("node ")),
    false,
  );
  assert.match(commands.at(-1), /agent-login-status/);
  assert.match(commands.at(-1), /restart-services/);
});

test("fresh-image setup makes npm available before the documented installer", async (t) => {
  const dir = temporary(t),
    bin = path.join(dir, "bin"),
    root = repository(t),
    id = "worker";
  fs.mkdirSync(bin);
  write(root, "source", "hello");
  const config = validateConfig({
    adapter: {
      install: "npm install -g agent",
      launch: "agent",
      resume: "agent resume",
      authCheck: "true",
    },
  });
  const baseline = captureSnapshot(root, config, path.join(dir, "baseline"));
  write(bin, "cloud-init", "#!/bin/sh\nexit 0\n", 0o755);
  write(
    bin,
    "apt-get",
    `#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = npm ]; then touch '${dir}/npm-ready'; fi; done\n`,
    0o755,
  );
  write(
    bin,
    "npm",
    `#!/bin/sh\ntest -f '${dir}/npm-ready' || exit 77\ntouch '${dir}/agent-installed'\n`,
    0o755,
  );
  const r = {
    id,
    baseline: baseline.directory,
    uploadApproval: { digest: baseline.digest },
    config,
  };
  const remote = new Remote({
    exec(record, command, options = {}) {
      return runSync(
        "bash",
        [
          "-c",
          command
            .replaceAll("/var/lib/herdr", dir + "/state")
            .replaceAll("/srv/herdr", dir + "/source"),
        ],
        {
          ...options,
          env: { ...process.env, PATH: bin + ":" + process.env.PATH },
        },
      );
    },
  });
  await remote.setup(r);
  assert.ok(fs.existsSync(path.join(dir, "agent-installed")));
  // A lost host state write after completed setup must not replay upload/install
  // over the independently changed remote source or its saved launch script.
  const remoteSource = path.join(dir, "source/workers/worker/source/source");
  fs.writeFileSync(remoteSource, "independent edit");
  await remote.setup(r);
  assert.equal(fs.readFileSync(remoteSource, "utf8"), "independent edit");
  fs.writeFileSync(remoteSource, "hello");
  r.baselineDigest = baseline.digest;
  r.checkpointDigest = baseline.digest;
  const first = await remote.checkpoint(r);
  const second = await remote.checkpoint(r);
  const state = path.join(dir, "state/workers/worker");
  assert.notEqual(first.sourceSnapshot, second.sourceSnapshot);
  assert.deepEqual(
    fs
      .readdirSync(state)
      .filter((name) => name.startsWith("checkpoint-source-")),
    [path.posix.basename(second.sourceSnapshot)],
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(state, "checkpoint.json"), "utf8"))
      .currentSourceDigest,
    baseline.digest,
  );

  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(dir, "state/workers/worker/identity.json"),
        "utf8",
      ),
    ).workerId,
    id,
  );
});
test("repeated exports and restore checks remove transient copies while checkpoint source remains durable", (t) => {
  const root = repository(t),
    dir = temporary(t),
    config = validateConfig({});
  write(root, "source", "hello");
  for (const mode of ["export", "verify"])
    for (let i = 0; i < 2; i++) {
      const target = path.join(dir, mode + i);
      const result = runSync(
        process.execPath,
        [transfer, mode, root, target, JSON.stringify(config)],
        { input: "{}" },
      );
      assert.ok(JSON.parse(result.stdout).digest);
      assert.equal(fs.existsSync(target), false);
    }
  const target = path.join(dir, "checkpoint");
  runSync(
    process.execPath,
    [transfer, "checkpoint", root, target, JSON.stringify(config)],
    { input: "{}" },
  );
  assert.ok(fs.existsSync(path.join(target, "files/source")));
});

test("native records use the owned helper and preserve the exact native observation; unmarked records keep tmux", () => {
  const commands = [],
    interactions = [],
    observation = {
      backend: "herdr",
      status: "detached",
      workspaceId: "observed-workspace",
      paneId: "observed-pane",
      terminalId: "observed-terminal",
      pid: 991,
      observedAt: "2026-11-18T00:00:00.000Z",
      agent: { agent: "codex", agent_status: "unknown" },
    };
  const remote = new Remote({
    exec(r, command) {
      commands.push(command);
      return { status: 0, stdout: JSON.stringify(observation) };
    },
    interactive(r, command) {
      interactions.push(command);
      return { code: 0 };
    },
  });
  const record = {
    id: "worker",
    guestBackend: "herdr",
    config: validateConfig({}),
  };
  assert.deepEqual(remote.ensureWorker(record), observation);
  assert.deepEqual(remote.inspectSession(record), observation);
  assert.deepEqual(
    remote.ensureWorker(record, { resumeApproved: true }),
    observation,
  );
  assert.match(commands.at(-1), /'resume'/);
  remote.attach(record);
  remote.restartAgent(record);
  assert.ok(commands.every((s) => s.includes("guest-herdr.mjs")));
  assert.ok(interactions[0].includes("'attach'"));
  assert.ok(!commands.join(" ").includes("tmux"));
  delete record.guestBackend;
  remote.ensureWorker(record);
  assert.match(commands.at(-1), /tmux has-session/);
});

test("native checkpoint refuses a live-writer rejection before capturing source", async () => {
  let captured = 0;
  const remote = new Remote({
    exec(record, command) {
      if (command.includes("guest-herdr.mjs")) throw Error("guest_writer_live");
      if (command.includes("remote-transfer.mjs")) {
        captured++;
        return { status: 0, stdout: JSON.stringify({ digest: "captured" }) };
      }
      return { status: 0, stdout: "" };
    },
  });
  await assert.rejects(
    remote.checkpoint({
      id: "worker",
      guestBackend: "herdr",
      config: validateConfig({}),
    }),
    /guest_writer_live/,
  );
  assert.equal(captured, 0);
});
