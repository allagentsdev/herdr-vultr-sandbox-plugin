import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Remote } from "../src/remote.mjs";
import { runSync, shellQuote as q } from "../src/process.mjs";
import { Store } from "../src/state.mjs";
import { Lifecycle } from "../src/lifecycle.mjs";
import { Connections } from "../src/connections.mjs";
import { temporary } from "./helpers.mjs";
async function fixture(t) {
  const store = new Store(temporary(t)),
    id = randomUUID(),
    events = [];
  await store.create({
    id,
    namespace: "test",
    localRoot: temporary(t),
    phase: "ready",
    vm: {
      serverId: "vm-42",
      plan: "vc2-2c-4gb",
      disk: 80,
      hostKey: "pinned",
      initialized: true,
    },
    config: { osId: 2284, plan: "vc2-2c-4gb" },
    pending: null,
  });
  let power = "running";
  const api = {
    async getServer() {
      return {
        id: "vm-42",
        powerState: power,
        volumes: [],
        tags: [
          "herdr-plugin=vultr.sandbox",
          `herdr-worker=${id}`,
          `herdr-operation=${store.get(id).pending?.operation}`,
        ],
      };
    },
    async request(method, url, body) {
      events.push(url);
      if (url.endsWith("/start")) power = "running";
      if (url.endsWith("/halt")) power = "off";
      if (url === "/snapshots")
        this.image = {
          id: "snap",
          description: body.description,
          status: "complete",
          size: 123,
          os_id: 2284,
        };
      return { snapshot: this.image };
    },
    async waitSnapshot() {
      return this.image;
    },
    async waitStatus(id, status) {
      assert.equal(power, status);
      return this.getServer();
    },
    async find() {
      return [];
    },
    async getImage() {
      return this.image;
    },
  };
  const remote = {
    async auth() {
      events.push("auth");
    },
    async activate() {
      events.push("activate");
    },
    async ensureWorker() {
      events.push("ensure");
    },
    async verifyResume() {
      events.push("verify");
    },
    async prepareSnapshot() {},
    async quiesce() {
      events.push("quiesce");
    },
    async checkpoint() {
      return {
        workerId: id,
        sourceDigest: "a".repeat(64),
        currentSourceDigest: "b".repeat(64),
        at: "2026-11-17T00:00:00Z",
      };
    },
  };
  const life = new Lifecycle(store, api, remote),
    connections = new Connections(store, life, remote, { pin: async (r) => r });
  return { store, id, api, remote, events, life, connections };
}
test("Resume activation and session creation finish before Hibernate can checkpoint", async (t) => {
  const f = await fixture(t);
  let entered, finish;
  const active = new Promise((resolve) => {
      entered = resolve;
    }),
    gate = new Promise((resolve) => {
      finish = resolve;
    });
  f.remote.activate = async () => {
    f.events.push("activate");
    entered();
    await gate;
  };
  const resume = f.connections.prepare(f.id, "resume");
  await active;
  const hibernate = f.life.hibernate(f.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.events.includes("quiesce"), false);
  finish();
  await resume;
  await hibernate;
  assert.ok(f.events.indexOf("ensure") < f.events.indexOf("quiesce"));
  assert.equal(f.store.get(f.id).hibernate.stage, "release");
  assert.equal(f.store.get(f.id).snapshot.checkpoint.workerId, f.id);
});
test("Reconnect after process restart finalizes the saved create before attaching and permits later Stop", async (t) => {
  const f = await fixture(t);
  await f.store.update(f.id, (r) => ({
    ...r,
    snapshot: { imageId: 7 },
    phase: "creating",
    pending: {
      kind: "create",
      operation: randomUUID(),
      attempted: true,
      actions: [91],
    },
  }));
  const restarted = new Store(f.store.directory),
    life = new Lifecycle(restarted, f.api, f.remote),
    connections = new Connections(restarted, life, f.remote, {
      pin: async (r) => r,
    });
  await connections.prepare(f.id, "reconnect");
  assert.equal(restarted.get(f.id).pending, null);
  assert.deepEqual(f.events, ["verify", "ensure"]);
  await life.power(f.id, "shutdown");
  assert.ok(f.events.includes("quiesce"));
});
test("ordinary reconnect with no server and no pending create never allocates compute", async (t) => {
  const f = await fixture(t);
  await f.store.update(f.id, (r) => ({ ...r, vm: null }));
  await assert.rejects(f.connections.prepare(f.id, "reconnect"), {
    code: "server_not_running",
  });
  assert.deepEqual(f.events, []);
});

test("restore readiness is durable before the coding agent can start", async (t) => {
  const f = await fixture(t);
  await f.store.update(f.id, (r) => ({
    ...r,
    snapshot: { imageId: 7 },
    phase: "restore-verification",
  }));
  f.remote.ensureWorker = async () => {
    assert.equal(f.store.get(f.id).phase, "ready");
  };
  await f.connections.prepare(f.id, "reconnect");
});

test("same allocated-VM Resume waits for pinned SSH boot readiness before auth/services or session creation", async (t) => {
  const f = await fixture(t);
  await f.life.power(f.id, "shutdown");
  const { Remote } = await import("../src/remote.mjs");
  let attempts = 0;
  const probe = new Remote({
    exec() {
      attempts++;
      if (attempts < 3) throw Error("Connection refused during boot");
      return { stdout: "", status: 0 };
    },
  });
  f.remote.waitReady = (r) => probe.waitReady(r, { attempts: 3, interval: 1 });
  f.remote.activate = async () => {
    assert.equal(attempts, 3);
    f.events.push("activate");
  };
  const before = f.store.get(f.id).vm.serverId;
  await f.connections.prepare(f.id, "resume");
  assert.equal(f.store.get(f.id).vm.serverId, before);
  assert.ok(f.events.indexOf("activate") < f.events.indexOf("ensure"));
  assert.equal(f.events.filter((e) => e.endsWith("/start")).length, 1);
});

test("explicit restart shares the worker lock with hibernation until the new agent is established", async (t) => {
  const f = await fixture(t);
  let entered, release;
  const active = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  f.remote.restartAgent = async () => {
    f.events.push("restart");
    entered();
    await gate;
  };
  const restart = f.connections.prepare(f.id, "restart-agent");
  await active;
  const hibernate = f.life.hibernate(f.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.events.includes("quiesce"), false);
  release();
  await restart;
  await hibernate;
  assert.ok(f.events.indexOf("restart") < f.events.indexOf("quiesce"));
});

test("native observations persist exact remote IDs and actual unknown agent state without claiming readiness", async (t) => {
  const f = await fixture(t);
  const observation = {
    backend: "herdr",
    status: "detached",
    workspaceId: "native-workspace",
    paneId: "native-pane",
    terminalId: "native-terminal",
    pid: 947,
    observedAt: "2026-11-18T00:00:00.000Z",
    agent: { agent: "codex", agent_status: "unknown" },
  };
  await f.store.update(f.id, (r) => ({ ...r, guestBackend: "herdr" }));
  f.remote.ensureWorker = async () => observation;
  const record = await f.connections.prepare(f.id, "reconnect");
  assert.deepEqual(record.guestHerdr, observation);
  assert.deepEqual(f.store.get(f.id).guestHerdr, observation);
  assert.deepEqual(f.events, ["auth"]);
});

test("lost native launch acknowledgement preserves restore readiness without inventing success", async (t) => {
  const f = await fixture(t);
  await f.store.update(f.id, (r) => ({
    ...r,
    guestBackend: "herdr",
    phase: "restore-verification",
    snapshot: { imageId: 7 },
  }));
  let sourceChanged = false,
    verified = 0;
  f.remote.verifyResume = async () => {
    assert.equal(
      sourceChanged,
      false,
      "snapshot verification must precede the initial launch",
    );
    verified++;
  };
  f.remote.ensureWorker = async (record, { resumeApproved }) => {
    assert.equal(f.store.get(f.id).phase, "ready");
    assert.equal(resumeApproved, true);
    sourceChanged = true;
    throw Error("launch acknowledgement lost");
  };
  await assert.rejects(
    f.connections.prepare(f.id, "reconnect"),
    /launch acknowledgement lost/,
  );
  assert.equal(f.store.get(f.id).phase, "ready");
  assert.equal(f.store.get(f.id).guestHerdr, undefined);
  const observed = {
    backend: "herdr",
    status: "detached",
    terminalId: "existing",
    observedAt: "2026-11-18T00:00:00.000Z",
  };
  f.remote.ensureWorker = async (record, { resumeApproved }) => {
    assert.equal(
      resumeApproved,
      false,
      "reconnect must not replay prior launch authorization",
    );
    return observed;
  };
  const next = await f.connections.prepare(f.id, "reconnect");
  assert.equal(verified, 1);
  assert.deepEqual(next.guestHerdr, observed);
});

async function failedAllocatedResume(t, alreadyRunning = false) {
  const f = await fixture(t),
    dir = temporary(t),
    source = path.join(dir, "source"),
    state = path.join(dir, "state"),
    writer = path.join(dir, "writer.mjs"),
    written = path.join(source, "written"),
    pidFile = path.join(dir, "writer.pid"),
    exitFile = path.join(dir, "writer-exited");
  fs.mkdirSync(source);
  fs.mkdirSync(state);
  fs.writeFileSync(
    path.join(state, "identity.json"),
    JSON.stringify({ workerId: f.id }),
  );
  fs.writeFileSync(path.join(state, "launch.sh"), "synthetic agent");
  fs.writeFileSync(written, "original source\n");
  fs.writeFileSync(
    writer,
    `import fs from "node:fs";
const timer = setInterval(() => fs.appendFileSync(process.argv[2], "new work\\n"), 10);
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
process.on("exit", () => fs.writeFileSync(process.argv[3], "exited"));
setTimeout(() => { clearInterval(timer); }, 5000);
`,
  );
  let pid;
  const stopWriter = async () => {
    if (!pid) return;
    const target = pid;
    try {
      process.kill(target, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    let exited = false;
    for (let i = 0; i < 100 && !exited; i++) {
      try {
        const stat = fs.readFileSync(`/proc/${target}/stat`, "utf8");
        exited = stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        exited = true;
      }
      if (!exited) await delay(10);
    }
    assert.equal(exited, true, "owned hook writer must exit before checkpoint");
    assert.equal(fs.readFileSync(exitFile, "utf8"), "exited");
    pid = null;
  };
  t.after(stopWriter);
  f.remote.quiesce = async () => {
    f.events.push("quiesce");
    await stopWriter();
    const stopped = fs.readFileSync(written, "utf8");
    await delay(30);
    assert.equal(fs.readFileSync(written, "utf8"), stopped);
  };
  f.remote.checkpoint = async () => {
    f.events.push("checkpoint");
    return {
      workerId: f.id,
      sourceDigest: "a".repeat(64),
      currentSourceDigest: createHash("sha256")
        .update(fs.readFileSync(written))
        .digest("hex"),
      at: new Date().toISOString(),
    };
  };
  const release = await f.life.hibernate(f.id),
    savedSnapshot = f.store.get(f.id).snapshot;
  await f.store.update(f.id, (r) => ({
    ...r,
    config: {
      ...r.config,
      adapter: {
        authCheck: ":",
        restart: `${q(process.execPath)} ${q(writer)} ${q(written)} ${q(exitFile)} </dev/null >/dev/null 2>&1 & echo $! > ${q(pidFile)}; exit 27`,
      },
    },
  }));
  const actual = new Remote({
    exec(record, command, options = {}) {
      return runSync(
        "sh",
        [
          "-c",
          command
            .replaceAll(`/srv/herdr/workers/${record.id}/source`, source)
            .replaceAll(`/var/lib/herdr/workers/${record.id}`, state),
        ],
        options,
      );
    },
  });
  f.remote.activate = (record) => {
    assert.equal(f.store.get(f.id).hibernate, null);
    return actual.activate(record);
  };
  if (alreadyRunning) await f.api.request("POST", "/instances/vm-42/start");
  f.events.length = 0;
  await assert.rejects(f.connections.prepare(f.id, "resume"), {
    code: "command_failed",
  });
  pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  for (
    let i = 0;
    i < 100 && !fs.readFileSync(written, "utf8").includes("new work");
    i++
  )
    await delay(10);
  assert.match(fs.readFileSync(written, "utf8"), /new work/);
  const heartbeat = fs.statSync(written).size;
  await delay(30);
  assert.ok(
    fs.statSync(written).size > heartbeat,
    "writer heartbeat must advance after failed Resume",
  );
  t.diagnostic(
    `configured restart hook launched a writer then exited 27; allocated Resume started ${alreadyRunning ? "running" : "off"}`,
  );
  return { ...f, release, savedSnapshot, written };
}

test("failed allocated Resume restarts a real hook writer then normal Stop captures fresh work", async (t) => {
  for (const alreadyRunning of [false, true]) {
    const f = await failedAllocatedResume(t, alreadyRunning);
    await f.life.power(f.id, "shutdown");
    assert.deepEqual(f.events.slice(-3), [
      "quiesce",
      "checkpoint",
      "/instances/vm-42/halt",
    ]);
    assert.equal(
      f.store.get(f.id).powerCheckpoint.currentSourceDigest,
      createHash("sha256").update(fs.readFileSync(f.written)).digest("hex"),
    );
    assert.notEqual(
      f.store.get(f.id).powerCheckpoint.currentSourceDigest,
      f.savedSnapshot.checkpoint.currentSourceDigest,
    );
    assert.deepEqual(f.store.get(f.id).snapshot, f.savedSnapshot);
  }
});

test("failed allocated Resume invalidates old release authority while retaining its snapshot", async (t) => {
  const f = await failedAllocatedResume(t);
  await f.life.power(f.id, "shutdown");
  const request = f.api.request;
  let deletions = 0;
  f.api.request = async (...args) => {
    if (args[0] === "DELETE") {
      deletions++;
      assert.fail("obsolete release authority reached DELETE");
    }
    return request(...args);
  };
  await assert.rejects(f.life.release(f.id, f.release.confirmation), {
    code: "approval_required",
  });
  assert.equal(deletions, 0);
  assert.deepEqual(f.store.get(f.id).snapshot, f.savedSnapshot);
  assert.equal(f.store.get(f.id).vm.serverId, "vm-42");
  assert.equal(
    f.events.some((event) => event.includes("DELETE")),
    false,
  );
});
