import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Store, atomicJson } from "../src/state.mjs";
import {
  serviceDefinition,
  ensureController,
  controllerStatus,
} from "../src/expiry-service.mjs";
import { monitoredWorkers } from "../src/expiry-controller.mjs";
import { validateConfig } from "../src/config.mjs";
import { temporary } from "./helpers.mjs";

async function until(fn) {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await delay(25);
  }
  assert.fail("isolated controller did not produce the expected receipt");
}

test("new idle default is exactly 15 minutes or explicitly off", () => {
  assert.equal(validateConfig().idleTimeoutMinutes, 15);
  assert.equal(validateConfig({ idleTimeoutMinutes: 0 }).idleTimeoutMinutes, 0);
  for (const idleTimeoutMinutes of [-1, 1, 14, 16, 1.5, "15", null])
    assert.throws(() => validateConfig({ idleTimeoutMinutes }), {
      code: "invalid_config",
    });
});

test("supervisor definitions isolate the Vultr user service and quote absolute paths", (t) => {
  const directory = path.join(temporary(t), 'state $%% & "quoted"');
  const linux = serviceDefinition(directory, {
    platform: "linux",
    home: temporary(t),
  });
  assert.match(linux.name, /^herdr-vultr-expiry-/);
  assert.match(linux.content, /Restart=always/);
  assert.ok(linux.content.includes('$$%%%% & \\"quoted\\"'));
  const mac = serviceDefinition(directory, {
    platform: "darwin",
    home: temporary(t),
    uid: 123,
  });
  assert.match(mac.content, /<key>KeepAlive<\/key><true\/>/);
  assert.match(mac.content, /&amp; &quot;quoted&quot;/);
  assert.throws(
    () => serviceDefinition(directory + "\n", { platform: "linux" }),
    { code: "invalid_service_path" },
  );
});

test("failed fake supervisor cannot report readiness; successful adapter persists private runtime and checks heartbeat", async (t) => {
  const store = new Store(temporary(t)),
    home = temporary(t);
  await assert.rejects(
    ensureController(store, {
      platform: "linux",
      home,
      run: () => ({ status: 1 }),
    }),
    { code: "controller_unavailable" },
  );
  assert.equal(controllerStatus(store).healthy, false);
  await ensureController(store, {
    platform: "linux",
    home,
    run: () => {
      atomicJson(path.join(store.directory, "expiry-controller.json"), {
        pid: process.pid,
        heartbeat: new Date().toISOString(),
      });
      return { status: 0 };
    },
  });
  assert.equal(controllerStatus(store).healthy, true);
  assert.equal(controllerStatus(store, Date.now() + 60000).healthy, false);
  assert.equal(
    fs.statSync(path.join(store.directory, "expiry-runtime.json")).mode & 0o777,
    0o600,
  );
  const unit = fs.readFileSync(
    serviceDefinition(store.directory, { platform: "linux", home }).file,
    "utf8",
  );
  assert.doesNotMatch(unit, /tokenFile|sshPrivateKey|credentials/);
});

test("isolated controller survives fake service restart, retains failures and never fabricates release", async (t) => {
  const store = new Store(temporary(t)),
    home = temporary(t),
    children = [];
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, "exit");
      }
    assert.ok(
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    );
  });
  const run = (command, args) => {
    assert.equal(command, "systemctl");
    if (args.includes("--now"))
      children.push(
        spawn(
          process.execPath,
          [path.join(store.directory, "expiry-launcher.mjs")],
          { stdio: "ignore" },
        ),
      );
    return { status: 0 };
  };
  await ensureController(store, { platform: "linux", home, run });
  const id = randomUUID(),
    serverId = randomUUID(),
    sessionId = randomUUID();
  await store.create({
    id,
    namespace: "fixture",
    localRoot: temporary(t),
    config: {
      tokenFile: path.join(home, "intentionally-missing-fixture-token"),
    },
    vm: { serverId },
    expiry: {
      approvedAt: new Date().toISOString(),
      mode: "idle",
      minutes: 15,
      session: { id: sessionId, serverId, state: "scheduled" },
    },
  });
  await until(() => !!store.get(id).expiry.lastControllerError);
  assert.equal(store.get(id).vm.serverId, serverId);
  assert.equal(monitoredWorkers(store).length, 1);
  children[0].kill();
  await once(children[0], "exit");
  await ensureController(store, { platform: "linux", home, run });
  await until(() => controllerStatus(store).pid === children[1].pid);
  assert.equal(store.get(id).expiry.session.id, sessionId);
  assert.equal(store.get(id).expiry.session.serverId, serverId);
});
