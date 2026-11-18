import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { SSH } from "../src/ssh.mjs";
import { Remote } from "../src/remote.mjs";
import { Store } from "../src/state.mjs";
import { temporary } from "./helpers.mjs";

test("controller SSH uses its actual 120 second default, readiness overrides to 20 seconds and interactive attachment has no deadline", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID(),
    calls = [],
    child = new EventEmitter();
  const r = {
    id,
    vm: {
      serverId: randomUUID(),
      hostKey: "ssh-ed25519 AAAA",
      ip: "192.0.2.1",
    },
  };
  await store.create({ ...r, namespace: "fixture", localRoot: temporary(t) });
  const ssh = new SSH(
    store,
    { sshPrivateKey: "/fixture-unused-key" },
    {
      commandTimeout: 120000,
      run: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { status: 0, stdout: "" };
      },
      spawnProcess: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return child;
      },
    },
  );
  ssh.exec(r, "controller-observation");
  assert.equal(calls.at(-1).options.timeout, 120000);
  assert.equal(calls.at(-1).options.killSignal, "SIGKILL");
  await new Remote(ssh).waitReady(r, { attempts: 1 });
  assert.equal(calls.at(-1).options.timeout, 20000);
  const interactive = ssh.interactive(r, "attach");
  assert.equal(calls.at(-1).options.timeout, undefined);
  child.emit("exit", 0, null);
  await interactive;
  const normal = new SSH(
    store,
    { sshPrivateKey: "/fixture-unused-key" },
    {
      run: (cmd, args, options) => {
        calls.push({ options });
        return { status: 0 };
      },
    },
  );
  normal.exec(r, "normal-operation");
  assert.equal(calls.at(-1).options.timeout, 300000);
});

test("controller command timeouts preserve their type through readiness and authentication", async (t) => {
  const timeout = Object.assign(Error("bounded command"), {
    code: "command_timeout",
  });
  const store = new Store(temporary(t)),
    id = randomUUID();
  const r = {
    id,
    config: { adapter: { authCheck: "auth-probe" } },
    vm: {
      serverId: randomUUID(),
      hostKey: "ssh-ed25519 AAAA",
      ip: "192.0.2.1",
    },
  };
  await store.create({ ...r, namespace: "fixture", localRoot: temporary(t) });
  const remote = new Remote(
    new SSH(
      store,
      { sshPrivateKey: "/fixture-unused-key" },
      {
        commandTimeout: 120000,
        run: () => {
          throw timeout;
        },
      },
    ),
  );
  await assert.rejects(remote.waitReady(r, { attempts: 1 }), {
    code: "command_timeout",
  });
  assert.throws(() => remote.auth(r), { code: "command_timeout" });
});
