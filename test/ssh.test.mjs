import test from "node:test";
import assert from "node:assert/strict";
import { sshArgs, tmuxCommand, verifyHostKey } from "../src/ssh.mjs";
import { createHash } from "node:crypto";
test("SSH transport pins a server-specific identity with no forwarding or ambient config", () => {
  const args = sshArgs(
    { sshPrivateKey: "/private/key" },
    {
      id: "worker",
      vm: { serverId: 42, ip: "192.0.2.1", hostKey: "ssh-ed25519 AAAA" },
    },
    "/private/known_hosts",
  );
  for (const option of [
    "StrictHostKeyChecking=yes",
    "ForwardAgent=no",
    "IdentitiesOnly=yes",
    "IdentityAgent=none",
    "HostKeyAlias=herdr-worker-42",
  ])
    assert.ok(args.includes(option));
  assert.ok(args.includes("/dev/null"));
  assert.ok(args.includes("UserKnownHostsFile=/private/known_hosts"));
  assert.throws(() => sshArgs({}, { vm: { ip: "-oProxyCommand=bad" } }, "/x"));
});
test("host pinning accepts only a matching console-verified SHA256 fingerprint", () => {
  const key = Buffer.from("test ssh wire public key").toString("base64");
  const fingerprint =
    "SHA256:" +
    createHash("sha256")
      .update(Buffer.from(key, "base64"))
      .digest("base64")
      .replace(/=+$/, "");
  assert.equal(
    verifyHostKey(`192.0.2.1 ssh-ed25519 ${key}\n`, fingerprint),
    `ssh-ed25519 ${key}`,
  );
  assert.throws(() =>
    verifyHostKey(`192.0.2.1 ssh-ed25519 ${key}\n`, "SHA256:wrong"),
  );
});
test("reattach uses tmux session existence and a persistent launch marker", () => {
  const command = tmuxCommand({ id: "worker" });
  assert.match(command, /has-session/);
  assert.match(command, /remain-on-exit/);
  assert.match(command, /flock/);
  assert.match(command, /started/);
  assert.doesNotMatch(command, /attach-session/);
});

test("real isolated tmux reattaches without duplicate launch and retains agent exit", async (t) => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { temporary } = await import("./helpers.mjs");
  const { runSync } = await import("../src/process.mjs");
  const dir = temporary(t),
    state = path.join(dir, "state"),
    socket = path.join(dir, "tmux.sock");
  fs.mkdirSync(state);
  t.after(() =>
    runSync("tmux", ["-S", socket, "kill-server"], { check: false }),
  );
  const launcher = `#!/bin/sh\ntouch '${state}/started'\necho launch >> '${state}/launches'\nsleep 1\n`;
  fs.writeFileSync(path.join(state, "launch.sh"), launcher);
  const command = tmuxCommand({ id: "worker" })
    .replaceAll("/var/lib/herdr/workers/worker", state)
    .replaceAll("tmux ", `tmux -S '${socket}' `)
    .replace(/exec tmux .*attach-session.*/, "true");
  runSync("bash", ["-c", command]);
  runSync("bash", ["-c", command]);
  for (let i = 0; i < 150; i++) {
    if (
      runSync(
        "tmux",
        [
          "-S",
          socket,
          "display-message",
          "-p",
          "-t",
          "herdr-worker",
          "#{pane_dead}",
        ],
        { check: false },
      ).stdout.trim() === "1"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  runSync("bash", ["-c", command]);
  assert.equal(
    fs.readFileSync(path.join(state, "launches"), "utf8"),
    "launch\n",
  );
  assert.equal(
    runSync("tmux", [
      "-S",
      socket,
      "display-message",
      "-p",
      "-t",
      "herdr-worker",
      "#{pane_dead}",
    ]).stdout.trim(),
    "1",
  );
  runSync("tmux", ["-S", socket, "kill-server"]);
  assert.notEqual(runSync("bash", ["-c", command], { check: false }).status, 0);
  fs.writeFileSync(path.join(state, "resume-approved"), "");
  runSync("bash", ["-c", command]);
  for (let i = 0; i < 150; i++) {
    if (
      fs.readFileSync(path.join(state, "launches"), "utf8") ===
      "launch\nlaunch\n"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    fs.readFileSync(path.join(state, "launches"), "utf8"),
    "launch\nlaunch\n",
  );
});

test("valid but wrong console fingerprint rejects the scanned key", () => {
  const key = Buffer.from("ssh-wire-key").toString("base64");
  const wrong =
    "SHA256:" +
    createHash("sha256")
      .update("different-key")
      .digest("base64")
      .replace(/=+$/, "");
  assert.throws(() => verifyHostKey(`192.0.2.1 ssh-ed25519 ${key}`, wrong), {
    code: "host_key_mismatch",
  });
});

test("a stale host-pin prompt cannot resurrect a deleted or replaced VM", async (t) => {
  const { SSH } = await import("../src/ssh.mjs");
  const { Store } = await import("../src/state.mjs");
  const { temporary } = await import("./helpers.mjs");
  const { randomUUID } = await import("node:crypto");
  for (const replacement of [null, { serverId: 99, hostKey: null }]) {
    const store = new Store(temporary(t)),
      id = randomUUID();
    const r = await store.create({
      id,
      localRoot: temporary(t),
      namespace: "test",
      vm: { serverId: 42, hostKey: null },
    });
    const key = Buffer.from("ssh-wire-key").toString("base64");
    const fingerprint =
      "SHA256:" +
      createHash("sha256")
        .update(Buffer.from(key, "base64"))
        .digest("base64")
        .replace(/=+$/, "");
    await store.update(id, (v) => ({ ...v, vm: replacement }));
    const ssh = new SSH(
      store,
      {},
      { run: () => ({ stdout: `192.0.2.1 ssh-ed25519 ${key}` }) },
    );
    await assert.rejects(
      ssh.pin(r, { id: 42, main_ip: "192.0.2.1" }, fingerprint),
      { code: "stale_server" },
    );
    assert.deepEqual(store.get(id).vm, replacement);
  }
});

test("explicit restart preserves a live agent, resumes a dead one once, and refuses a stale dead observation", async (t) => {
  const fs = await import("node:fs"),
    path = await import("node:path");
  const { temporary } = await import("./helpers.mjs");
  const { runSync, shellQuote: q } = await import("../src/process.mjs");
  const { Remote } = await import("../src/remote.mjs");
  const dir = temporary(t),
    state = path.join(dir, "state"),
    socket = path.join(dir, "tmux.sock"),
    bin = path.join(dir, "bin"),
    real = runSync("which", ["tmux"]).stdout.trim(),
    session = "herdr-worker";
  fs.mkdirSync(state);
  fs.mkdirSync(bin);
  t.after(() => runSync(real, ["-S", socket, "kill-server"], { check: false }));
  fs.writeFileSync(
    path.join(state, "launch.sh"),
    `#!/bin/sh\necho launch >> ${q(state + "/launches")}\nexec sleep 30\n`,
  );
  const command = tmuxCommand({ id: "worker" })
    .replaceAll("/var/lib/herdr/workers/worker", state)
    .replaceAll("tmux ", `${q(real)} -S ${q(socket)} `);
  runSync("bash", ["-c", command]);
  const tmux = (args) => runSync(real, ["-S", socket, ...args]);
  const until = async (fn) => {
    for (let i = 0; i < 50; i++) {
      if (fn()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("Private tmux transition did not finish");
  };
  await until(() => fs.existsSync(state + "/launches"));
  const remote = new Remote({
    exec(_r, cmd) {
      return runSync(
        "bash",
        ["-c", cmd.replaceAll("/var/lib/herdr/workers/worker", state)],
        { env: { ...process.env, PATH: bin + ":" + process.env.PATH } },
      );
    },
  });
  fs.writeFileSync(
    bin + "/tmux",
    `#!/bin/sh\nexec ${q(real)} -S ${q(socket)} "$@"\n`,
    { mode: 0o700 },
  );
  const pid = () =>
      Number(
        tmux([
          "display-message",
          "-p",
          "-t",
          session,
          "#{pane_pid}",
        ]).stdout.trim(),
      ),
    dead = () =>
      tmux([
        "display-message",
        "-p",
        "-t",
        session,
        "#{pane_dead}",
      ]).stdout.trim() === "1";
  const first = pid();
  assert.throws(() => remote.restartAgent({ id: "worker" }));
  assert.equal(pid(), first);
  assert.equal(fs.readFileSync(state + "/launches", "utf8"), "launch\n");
  process.kill(first, "SIGTERM");
  await until(dead);
  remote.restartAgent({ id: "worker" });
  await until(
    () => fs.readFileSync(state + "/launches", "utf8") === "launch\nlaunch\n",
  );
  assert.notEqual(pid(), first);
  process.kill(pid(), "SIGTERM");
  await until(dead);
  fs.writeFileSync(
    state + "/racer.sh",
    `#!/bin/sh\necho $$ > ${q(state + "/race-pid")}\nexec sleep 30\n`,
  );
  fs.writeFileSync(
    bin + "/tmux",
    `#!/bin/sh\nif [ "$1" = display-message ]; then\nobserved="$(${q(real)} -S ${q(socket)} "$@")"\nif [ "$observed" = 1 ]; then ${q(real)} -S ${q(socket)} respawn-pane -t ${q(session)} ${q("bash " + q(state + "/racer.sh"))}; fi\nprintf '%s\\n' "$observed"\nelse exec ${q(real)} -S ${q(socket)} "$@"; fi\n`,
    { mode: 0o700 },
  );
  assert.throws(() => remote.restartAgent({ id: "worker" }));
  await until(() => fs.existsSync(state + "/race-pid"));
  assert.equal(pid(), Number(fs.readFileSync(state + "/race-pid", "utf8")));
  assert.equal(
    fs.readFileSync(state + "/launches", "utf8"),
    "launch\nlaunch\n",
  );
});

test("noninteractive SSH bounds a stalled command without exposing remote output", async (t) => {
  const { SSH } = await import("../src/ssh.mjs");
  const { Store } = await import("../src/state.mjs");
  const { runSync } = await import("../src/process.mjs");
  const { temporary } = await import("./helpers.mjs");
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID(),
    store = new Store(temporary(t));
  const ssh = new SSH(
    store,
    { sshPrivateKey: "/unused" },
    {
      run: (_command, _args, options) =>
        runSync(
          process.execPath,
          [
            "-e",
            "setTimeout(()=>{process.stdout.write('private-output')},300)",
          ],
          options,
        ),
    },
  );
  assert.throws(
    () =>
      ssh.exec(
        {
          id,
          vm: { serverId: "vm", ip: "192.0.2.1", hostKey: "ssh-ed25519 AAAA" },
        },
        "blocked-command",
        { timeout: 30 },
      ),
    (e) =>
      e.code === "command_timeout" && !e.message.includes("private-output"),
  );
});
test("SSH commands have default deadlines and server-alive probes while interactive sessions remain separate", async (t) => {
  const { SSH } = await import("../src/ssh.mjs");
  const { Store } = await import("../src/state.mjs");
  const { temporary } = await import("./helpers.mjs");
  const { randomUUID } = await import("node:crypto");
  let options, args;
  const ssh = new SSH(
    new Store(temporary(t)),
    { sshPrivateKey: "/unused" },
    {
      run: (_cmd, a, o) => {
        args = a;
        options = o;
        return { status: 0, stdout: "" };
      },
    },
  );
  ssh.exec(
    {
      id: randomUUID(),
      vm: { serverId: "vm", ip: "192.0.2.1", hostKey: "ssh-ed25519 AAAA" },
    },
    "true",
  );
  assert.equal(options.timeout, 300000);
  assert.equal(options.killSignal, "SIGKILL");
  assert.ok(args.includes("ServerAliveInterval=15"));
  assert.ok(args.includes("ServerAliveCountMax=3"));
});
