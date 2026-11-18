// Actual owned stock Herdr; synthetic writer and filesystem failure injection.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const binary = process.env.VULTR_HERDR_TEST_BIN;
assert.ok(
  binary && path.isAbsolute(binary),
  "Set VULTR_HERDR_TEST_BIN to official Herdr",
);
const helper = fileURLToPath(
  new URL("../src/guest-herdr.mjs", import.meta.url),
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, message) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await pause(50);
  }
  throw Error(message);
}
const q = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
function fixture() {
  const root = fs.mkdtempSync("/tmp/vghr-"),
    state = root + "/state",
    source = root + "/source",
    id = "00000000-0000-4000-8000-000000000002",
    log = [],
    ownedWriters = new Set();
  fs.mkdirSync(state + "/tools", { recursive: true });
  fs.mkdirSync(source);
  fs.writeFileSync(
    state + "/tools/herdr",
    `#!/bin/sh\nif [ "$1" = server ] && [ "$#" = 1 ]; then echo $$ > ${q(state + "/server-pid")}; echo start >> ${q(state + "/server-starts")}; fi\nexec ${q(binary)} "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    state + "/writer.mjs",
    `import fs from 'node:fs';\nprocess.on('SIGHUP',()=>{}); process.on('SIGTERM',()=>{});\nfs.writeFileSync(${JSON.stringify(state + "/writer-pid")},String(process.pid));\nsetInterval(()=>fs.appendFileSync(${JSON.stringify(source + "/writes")},'write\\n'),50);\n`,
  );
  fs.writeFileSync(
    state + "/launch.sh",
    `#!/bin/sh\ntouch ${q(state + "/started")}\necho launch >> ${q(state + "/launches")}\nexec ${q(process.execPath)} ${q(state + "/writer.mjs")}\n`,
  );
  function call(op, allowFailure = false, targetSource = source) {
    const r = spawnSync(
      "flock",
      [
        state + "/herdr-worker.lock",
        process.execPath,
        helper,
        op,
        state,
        id,
        targetSource,
      ],
      { encoding: "utf8", timeout: 40000 },
    );
    log.push({ op, status: r.status, stdout: r.stdout, stderr: r.stderr });
    fs.writeFileSync(root + "/proof.json", JSON.stringify(log, null, 2));
    if (!allowFailure) assert.equal(r.status, 0, r.stderr);
    return r;
  }
  const writerAlive = () => {
    try {
      const pid = Number(fs.readFileSync(state + "/writer-pid", "utf8"));
      ownedWriters.add(pid);
      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      return !["Z", "X"].includes(
        stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
      );
    } catch {
      return false;
    }
  };
  async function cleanup() {
    writerAlive();
    for (const pid of ownedWriters) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // An already exited owned child needs no cleanup.
      }
    }
    call("quiesce", true);
  }
  return { root, state, source, id, log, call, writerAlive, cleanup };
}
test("failed approved continuation revokes approval even before server setup succeeds", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.state + "/started", "");
    fs.writeFileSync(f.state + "/resume-approved", "");
    const r = f.call("resume", true, f.source + "/missing");
    assert.notEqual(r.status, 0);
    assert.equal(fs.existsSync(f.state + "/resume-approved"), false);
  } finally {
    await f.cleanup();
    console.log("Failed-resume proof: " + f.root + "/proof.json");
  }
});
test("unavailable server cannot quiesce or approve a second writer while its actual child survives", async () => {
  const f = fixture();
  try {
    f.call("ensure");
    await until(
      () => f.writerAlive() && fs.existsSync(f.source + "/writes"),
      "writer did not start",
    );
    const writerPid = Number(fs.readFileSync(f.state + "/writer-pid", "utf8"));
    const leaseFd = fs.readdirSync("/proc/" + writerPid + "/fd").find((fd) => {
      try {
        return (
          fs.readlinkSync("/proc/" + writerPid + "/fd/" + fd) ===
          f.state + "/herdr-agent.lock"
        );
      } catch {
        return false;
      }
    });
    assert.ok(leaseFd, "actual writer must inherit lifetime lease fd");
    const serverPid = Number(fs.readFileSync(f.state + "/server-pid", "utf8"));
    process.kill(serverPid, "SIGKILL");
    await pause(150);
    assert.equal(
      f.writerAlive(),
      true,
      "survival is a precondition, not an assumed lease result",
    );
    const before = fs.statSync(f.source + "/writes").size;
    await pause(150);
    assert.ok(
      fs.statSync(f.source + "/writes").size > before,
      "actual writer must still mutate source",
    );
    console.log(
      JSON.stringify({
        childSurvived: true,
        leaseFd,
        sourceBytesBefore: before,
        sourceBytesAfter: fs.statSync(f.source + "/writes").size,
        root: f.root,
        writerPid: Number(fs.readFileSync(f.state + "/writer-pid", "utf8")),
      }),
    );
    assert.ok(
      fs.lstatSync(f.state + "/herdr.sock").isSocket(),
      "SIGKILL must leave the actual owned socket",
    );
    const stopped = f.call("quiesce", true);
    const captured = f.call("checkpoint", true);
    fs.writeFileSync(f.state + "/resume-approved", "");
    const resumed = f.call("resume", true);
    assert.notEqual(
      stopped.status,
      0,
      "cannot checkpoint a surviving writer with a stale socket",
    );
    assert.notEqual(
      captured.status,
      0,
      "checkpoint must refuse actual surviving writer",
    );
    assert.match(stopped.stderr, /guest_writer_live/);
    assert.match(captured.stderr, /guest_writer_live/);
    assert.notEqual(
      resumed.status,
      0,
      "APPROVED Resume must reach and refuse the live writer guard",
    );
    assert.match(resumed.stderr, /guest_writer_live/);
    assert.equal(f.writerAlive(), true);
    assert.equal(fs.existsSync(f.state + "/resume-approved"), false);
    process.kill(writerPid, "SIGKILL");
    await until(() => !f.writerAlive(), "owned child did not exit");
    assert.equal(f.call("quiesce").status, 0);
    assert.equal(
      fs.existsSync(f.state + "/herdr.sock"),
      false,
      "quiesce removes only the confirmed stale socket",
    );
    assert.equal(
      fs.readFileSync(f.state + "/server-starts", "utf8"),
      "start\n",
      "quiesce must leave the server unstarted",
    );
    assert.equal(
      fs.readFileSync(f.state + "/launches", "utf8"),
      "launch\n",
      "quiesce must not launch a child",
    );
    assert.equal(f.call("checkpoint").status, 0);
    fs.writeFileSync(f.state + "/resume-approved", "");
    f.call("resume");
    await until(
      () => f.writerAlive(),
      "approved continuation did not launch after writer exit",
    );
    assert.equal(
      fs.readFileSync(f.state + "/server-starts", "utf8"),
      "start\nstart\n",
    );
    assert.equal(
      fs.readFileSync(f.state + "/launches", "utf8"),
      "launch\nlaunch\n",
    );
  } finally {
    await f.cleanup();
    console.log("Surviving-writer proof: " + f.root + "/proof.json");
  }
});

test("a leftover Resume token alone cannot authorize ordinary reconnect", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.state + "/started", "");
    fs.writeFileSync(f.state + "/resume-approved", "");
    const result = f.call("ensure", true);
    assert.notEqual(
      result.status,
      0,
      "ordinary ensure cannot consume stale disk approval as permission",
    );
    assert.equal(fs.existsSync(f.state + "/resume-approved"), false);
  } finally {
    await f.cleanup();
    console.log("Stale-token proof: " + f.root + "/proof.json");
  }
});

const processAlive = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(
      stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0],
    );
  } catch {
    return false;
  }
};
async function stopWriter(f) {
  await until(() => f.writerAlive(), "writer did not start");
  const pid = Number(fs.readFileSync(f.state + "/writer-pid", "utf8"));
  process.kill(pid, "SIGKILL");
  await until(() => !f.writerAlive(), "owned writer did not exit");
}

test("missing server ownership never authorizes stopping a responsive live server", async () => {
  const f = fixture();
  let saved;
  try {
    f.call("ensure");
    await stopWriter(f);
    const pid = Number(fs.readFileSync(f.state + "/server-pid", "utf8"));
    saved = fs.readFileSync(f.state + "/herdr-server.json");
    fs.unlinkSync(f.state + "/herdr-server.json");
    const result = f.call("quiesce", true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /guest_herdr_stop_unconfirmed/);
    assert.equal(
      processAlive(pid),
      true,
      "unknown live server must not receive Stop",
    );
    assert.ok(fs.lstatSync(f.state + "/herdr.sock").isSocket());
    process.kill(pid, "SIGKILL");
    await until(() => !processAlive(pid), "owned server did not exit");
    for (const op of ["quiesce", "resume"]) {
      if (op === "resume") fs.writeFileSync(f.state + "/resume-approved", "");
      const uncertain = f.call(op, true);
      assert.notEqual(uncertain.status, 0);
      assert.match(uncertain.stderr, /guest_herdr_stop_unconfirmed/);
      assert.ok(
        fs.lstatSync(f.state + "/herdr.sock").isSocket(),
        "missing ownership must retain the stale endpoint",
      );
    }
  } finally {
    if (saved) fs.writeFileSync(f.state + "/herdr-server.json", saved);
    await f.cleanup();
    console.log("Missing-ownership proof: " + f.root + "/proof.json");
  }
});

test("SIGSTOP with an ambiguous birth record cannot unlink or replace a listening server", async () => {
  const f = fixture();
  let pid, saved;
  try {
    f.call("ensure");
    await stopWriter(f);
    pid = Number(fs.readFileSync(f.state + "/server-pid", "utf8"));
    const before = fs.lstatSync(f.state + "/herdr.sock", { bigint: true });
    saved = fs.readFileSync(f.state + "/herdr-server.json");
    fs.writeFileSync(
      f.state + "/herdr-server.json",
      JSON.stringify({ ...JSON.parse(saved), started: "0" }),
    );
    process.kill(pid, "SIGSTOP");
    for (const op of ["quiesce", "resume"]) {
      if (op === "resume") fs.writeFileSync(f.state + "/resume-approved", "");
      const result = f.call(op, true);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /guest_herdr_stop_unconfirmed/);
      assert.equal(processAlive(pid), true);
      const current = fs.lstatSync(f.state + "/herdr.sock", { bigint: true });
      assert.equal(current.ino, before.ino);
      assert.equal(current.ctimeNs, before.ctimeNs);
      assert.equal(
        fs.readFileSync(f.state + "/server-starts", "utf8"),
        "start\n",
      );
    }
  } finally {
    if (pid && processAlive(pid)) process.kill(pid, "SIGCONT");
    if (saved) fs.writeFileSync(f.state + "/herdr-server.json", saved);
    if (pid && processAlive(pid) && !fs.existsSync(f.state + "/herdr.sock")) {
      // Negative-proof cleanup: the pre-fix helper incorrectly unlinked this
      // owned server. Stop that exact fixture PID, never any ambient process.
      process.kill(pid, "SIGTERM");
      await until(() => !processAlive(pid), "owned server did not exit");
    }
    await f.cleanup();
    console.log("Unresponsive-server proof: " + f.root + "/proof.json");
  }
});

test("replacement endpoint and changed process identity remain fail-closed", async () => {
  const f = fixture();
  let replacement;
  try {
    f.call("ensure");
    await stopWriter(f);
    const pid = Number(fs.readFileSync(f.state + "/server-pid", "utf8"));
    const record = JSON.parse(
      fs.readFileSync(f.state + "/herdr-server.json", "utf8"),
    );
    fs.writeFileSync(
      f.state + "/herdr-server.json",
      JSON.stringify({ ...record, started: "0" }),
    );
    const changed = f.call("quiesce", true);
    assert.notEqual(changed.status, 0);
    assert.equal(processAlive(pid), true);
    fs.writeFileSync(f.state + "/herdr-server.json", JSON.stringify(record));
    process.kill(pid, "SIGKILL");
    await until(() => !processAlive(pid), "owned server did not exit");
    const base = f.state + "/herdr";
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
    );
    Object.assign(env, {
      HOME: base + "/home",
      SHELL: "/bin/sh",
      HERDR_SESSION: "worker-" + f.id,
      HERDR_SOCKET_PATH: f.state + "/herdr.sock",
      HERDR_CONFIG_PATH: base + "/config/herdr/config.toml",
      XDG_CONFIG_HOME: base + "/config",
      XDG_STATE_HOME: base + "/state",
      XDG_CACHE_HOME: base + "/cache",
      XDG_RUNTIME_DIR: base + "/runtime",
    });
    const log = fs.openSync(f.root + "/replacement.log", "w", 0o600);
    replacement = spawn(binary, ["server"], {
      cwd: f.source,
      env,
      stdio: ["ignore", log, log],
    });
    fs.closeSync(log);
    await until(() => {
      try {
        const stat = fs.lstatSync(f.state + "/herdr.sock", { bigint: true });
        return (
          String(stat.ino) !== record.socket.ino ||
          String(stat.ctimeNs) !== record.socket.ctimeNs
        );
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }, "replacement endpoint did not appear");
    const before = fs.lstatSync(f.state + "/herdr.sock", { bigint: true });
    for (const op of ["quiesce", "resume"]) {
      if (op === "resume") fs.writeFileSync(f.state + "/resume-approved", "");
      const result = f.call(op, true);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /guest_herdr_stop_unconfirmed/);
      assert.equal(
        processAlive(replacement.pid),
        true,
        "replacement must not be stopped",
      );
      assert.equal(
        fs.lstatSync(f.state + "/herdr.sock", { bigint: true }).ino,
        before.ino,
      );
    }
  } finally {
    if (replacement) {
      replacement.kill("SIGTERM");
      await until(
        () => !processAlive(replacement.pid),
        "owned replacement did not exit",
      );
      // Test owns this replacement; removing its dead endpoint is fixture cleanup.
      fs.rmSync(f.state + "/herdr.sock", { force: true });
    }
    await f.cleanup();
    console.log("Changed-identity proof: " + f.root + "/proof.json");
  }
});

test("recorded server death survives modeled PID reuse and boot change without touching the unrelated process", async () => {
  for (const mode of ["start", "boot"]) {
    const f = fixture();
    let unrelated;
    try {
      f.call("ensure");
      await stopWriter(f);
      const record = JSON.parse(
        fs.readFileSync(f.state + "/herdr-server.json", "utf8"),
      );
      process.kill(record.pid, "SIGKILL");
      await until(
        () => !processAlive(record.pid),
        "original owned server did not exit",
      );
      unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore" },
      );
      await until(
        () => processAlive(unrelated.pid),
        "owned unrelated process did not start",
      );
      const stat = fs.readFileSync(`/proc/${unrelated.pid}/stat`, "utf8");
      const started = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
      assert.notEqual(
        started,
        record.started,
        "fixture needs distinct real process births",
      );
      // Model PID reuse without changing the host PID allocator. The original
      // server is actually dead, its exact socket remains, and this PID is live.
      const previous =
        mode === "start"
          ? { ...record, pid: unrelated.pid }
          : {
              ...record,
              pid: unrelated.pid,
              started,
              bootId: "00000000-0000-4000-8000-000000000000",
            };
      fs.writeFileSync(
        f.state + "/herdr-server.json",
        JSON.stringify(previous),
      );
      assert.equal(f.call("quiesce").status, 0);
      assert.equal(processAlive(unrelated.pid), true);
      assert.equal(fs.existsSync(f.state + "/herdr.sock"), false);
      assert.equal(
        fs.readFileSync(f.state + "/server-starts", "utf8"),
        "start\n",
      );
      fs.writeFileSync(f.state + "/resume-approved", "");
      f.call("resume");
      await until(
        () => f.writerAlive(),
        "approved Resume after original death did not launch",
      );
      assert.equal(processAlive(unrelated.pid), true);
      assert.equal(
        fs.readFileSync(f.state + "/server-starts", "utf8"),
        "start\nstart\n",
      );
      console.log(
        JSON.stringify({
          originalServerDead: true,
          identityReuseModeled: mode,
          unrelatedPid: unrelated.pid,
          root: f.root,
        }),
      );
    } finally {
      if (unrelated) {
        unrelated.kill("SIGTERM");
        await until(
          () => !processAlive(unrelated.pid),
          "owned unrelated process did not exit",
        );
      }
      await f.cleanup();
      console.log("Reused-identity proof: " + f.root + "/proof.json");
    }
  }
});
