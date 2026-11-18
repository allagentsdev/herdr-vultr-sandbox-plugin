import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, atomicJson } from "../src/state.mjs";
import { Lifecycle } from "../src/lifecycle.mjs";
import { temporary } from "./helpers.mjs";

async function stopFixture(t) {
  const store = new Store(temporary(t)),
    id = randomUUID();
  await store.create({
    id,
    namespace: "synthetic",
    localRoot: temporary(t),
    vm: { serverId: "synthetic-vm" },
    config: {},
    phase: "ready",
  });
  let power = "running";
  const requests = [],
    api = {
      async getServer() {
        return {
          id: "synthetic-vm",
          powerState: power,
          volumes: [],
          tags: ["herdr-plugin=vultr.sandbox", `herdr-worker=${id}`],
        };
      },
      async request(method, url) {
        requests.push({ method, url });
        power = "off";
        return {};
      },
      async waitStatus() {
        return this.getServer();
      },
    };
  const life = new Lifecycle(store, api, {
    async quiesce() {},
    async checkpoint() {
      return { workerId: id };
    },
  });
  return { store, id, requests, api, life };
}

function observeAttemptBarriers(t, store, id, failure) {
  const events = [],
    descriptors = new Map(),
    file = store.file(id),
    directory = path.dirname(file),
    open = fs.openSync,
    close = fs.closeSync,
    sync = fs.fsyncSync,
    rename = fs.renameSync;
  const attempted = (name) => {
    const record = JSON.parse(fs.readFileSync(name, "utf8"));
    return record.pending?.attempted && !record.pending.acknowledged;
  };
  t.mock.method(fs, "openSync", (name, ...args) => {
    const fd = open(name, ...args);
    if (
      name === directory ||
      (typeof name === "string" &&
        name.startsWith(file + ".") &&
        name.endsWith(".tmp"))
    )
      descriptors.set(fd, name);
    return fd;
  });
  t.mock.method(fs, "closeSync", (fd) => {
    close(fd);
    descriptors.delete(fd);
  });
  t.mock.method(fs, "fsyncSync", (fd) => {
    const name = descriptors.get(fd),
      isDirectory = name === directory;
    if (name && attempted(isDirectory ? file : name)) {
      const boundary = isDirectory ? "directory-sync" : "file-sync";
      events.push(boundary);
      if (failure === boundary) throw Error(`injected ${boundary} failure`);
    }
    return sync(fd);
  });
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === file && attempted(from)) events.push("rename");
    return rename(from, to);
  });
  return { events, descriptors };
}

test("real Store syncs attempted receipt data then renamed directory entry before provider Stop", async (t) => {
  const f = await stopFixture(t),
    observed = observeAttemptBarriers(t, f.store, f.id),
    request = f.api.request;
  f.api.request = async (...args) => {
    observed.events.push("provider-stop");
    assert.deepEqual(observed.events, [
      "file-sync",
      "rename",
      "directory-sync",
      "provider-stop",
    ]);
    assert.equal(f.store.get(f.id).pending.attempted, true);
    assert.equal(fs.statSync(f.store.file(f.id)).mode & 0o777, 0o600);
    return request(...args);
  };
  await f.life.power(f.id, "shutdown");
  assert.equal(f.requests.length, 1);
  assert.equal(observed.descriptors.size, 0);
  t.diagnostic(
    "observed actual fsync(file) -> rename -> fsync(parent) -> synthetic provider Stop; no power-loss experiment",
  );
});

for (const failure of ["file-sync", "directory-sync"]) {
  test(`attempted receipt ${failure} failure prevents provider submission and closes owned resources`, async (t) => {
    const f = await stopFixture(t),
      observed = observeAttemptBarriers(t, f.store, f.id, failure);
    await assert.rejects(
      f.life.power(f.id, "shutdown"),
      new RegExp(`injected ${failure} failure`),
    );
    assert.deepEqual(f.requests, []);
    assert.equal(observed.descriptors.size, 0);
    assert.deepEqual(fs.readdirSync(f.store.directory), [
      path.basename(f.store.file(f.id)),
    ]);
    assert.equal(fs.statSync(f.store.file(f.id)).mode & 0o777, 0o600);
    assert.equal(
      f.store.get(f.id).pending.attempted,
      failure === "directory-sync",
    );
    if (failure === "directory-sync") {
      const retained = f.store.get(f.id).pending;
      t.mock.restoreAll();
      await assert.rejects(f.life.power(f.id, "shutdown"), {
        code: "outcome_unknown",
      });
      assert.deepEqual(f.requests, []);
      assert.deepEqual(f.store.get(f.id).pending, retained);
    }
  });
}

test("atomic JSON replacement keeps old bytes on file sync failure and removes its temporary file", (t) => {
  const directory = temporary(t),
    file = path.join(directory, "record.json");
  atomicJson(file, { old: true });
  t.mock.method(fs, "fsyncSync", () => {
    throw Error("injected sync failure");
  });
  assert.throws(
    () => atomicJson(file, { replacement: true }),
    /injected sync failure/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { old: true });
  assert.deepEqual(fs.readdirSync(directory), ["record.json"]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
