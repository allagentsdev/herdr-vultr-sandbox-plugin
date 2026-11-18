// Actual owned stock Herdr; synthetic writer and filesystem failure injection.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
    `#!/bin/sh\nif [ "$1" = server ] && [ "$#" = 1 ]; then echo $$ > ${q(state + "/server-pid")}; fi\nexec ${q(binary)} "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    state + "/writer.mjs",
    `import fs from 'node:fs';\nprocess.on('SIGHUP',()=>{}); process.on('SIGTERM',()=>{});\nfs.writeFileSync(${JSON.stringify(state + "/writer-pid")},String(process.pid));\nsetInterval(()=>fs.appendFileSync(${JSON.stringify(source + "/writes")},'write\\n'),50);\n`,
  );
  fs.writeFileSync(
    state + "/launch.sh",
    `#!/bin/sh\ntouch ${q(state + "/started")}\nexec ${q(process.execPath)} ${q(state + "/writer.mjs")}\n`,
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
      { encoding: "utf8", timeout: 20000 },
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
    // Removing an owned stale socket is filesystem cleanup, not writer termination.
    fs.rmSync(f.state + "/herdr.sock", { force: true });
    const stopped = f.call("quiesce", true);
    const captured = f.call("checkpoint", true);
    fs.writeFileSync(f.state + "/resume-approved", "");
    const resumed = f.call("resume", true);
    assert.notEqual(
      stopped.status,
      0,
      "cannot checkpoint a surviving writer after stale socket cleanup",
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
    assert.equal(f.call("checkpoint").status, 0);
    fs.writeFileSync(f.state + "/resume-approved", "");
    f.call("resume");
    await until(
      () => f.writerAlive(),
      "approved continuation did not launch after writer exit",
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
