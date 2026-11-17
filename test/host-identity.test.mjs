import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Store } from "../src/state.mjs";
import { Lifecycle } from "../src/lifecycle.mjs";
import { temporary } from "./helpers.mjs";
import { HostIdentities } from "../src/host-identity.mjs";
test("fresh VM host identities are purpose-specific, private and durable before provider create", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID(),
    identities = new HostIdentities(store);
  const op = randomUUID();
  const first = identities.prepare(id, op),
    again = identities.prepare(id, op),
    next = identities.prepare(id, randomUUID());
  assert.equal(first.publicKey, again.publicKey);
  assert.notEqual(first.publicKey, next.publicKey);
  assert.equal(fs.statSync(first.privateKeyFile).mode & 0o777, 0o600);
  const userData = JSON.parse(
    identities.cloudConfig(first).split("\n").slice(1).join("\n"),
  );
  assert.equal(userData.ssh_keys.ed25519_public.trim(), first.publicKey);
  assert.ok(
    userData.ssh_keys.ed25519_private.startsWith(
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ),
  );
  // cloud-init rejects a present but empty ssh_genkeytypes (minItems: 1).
  assert.ok(
    !Object.hasOwn(userData, "ssh_genkeytypes") ||
      userData.ssh_genkeytypes.length > 0,
    "Provisioned cloud-config must pass cloud-init's key-generation schema",
  );
  assert.equal(
    /HCLOUD_TOKEN|OPENAI_API_KEY|sshPrivateKey/.test(
      identities.cloudConfig(first),
    ),
    false,
  );
});
test("lost create reconciles the same public pin and a restored VM gets a fresh identity", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID();
  await store.create({
    id,
    namespace: "test",
    localRoot: temporary(t),
    config: {
      plan: "vc2-2c-4gb",
      region: "syd",
      osId: 2284,
      hostKeyMode: "provisioned",
    },
    vm: null,
  });
  let server,
    posts = 0,
    fail = true;
  const api = {
    async find() {
      return server ? [server] : [];
    },
    async request(method, url, body) {
      assert.equal(url, "/instances");
      posts++;
      const before = store.get(id);
      assert.ok(before.pending.hostIdentity.publicKey);
      assert.ok(fs.existsSync(before.pending.hostIdentity.privateKeyFile));
      const transmitted = JSON.parse(
        Buffer.from(body.user_data, "base64")
          .toString()
          .split("\n")
          .slice(1)
          .join("\n"),
      );
      assert.equal(
        transmitted.ssh_keys.ed25519_public.trim(),
        before.pending.hostIdentity.publicKey,
      );
      assert.equal(
        transmitted.ssh_keys.ed25519_private.trim() ===
          fs
            .readFileSync(before.pending.hostIdentity.privateKeyFile, "utf8")
            .trim(),
        true,
        "Provider must receive this operation server key, not host client authentication",
      );
      assert.equal(transmitted.ssh_deletekeys, true);
      assert.deepEqual(transmitted.users[0].ssh_authorized_keys, [
        "ssh-ed25519 AAAA",
      ]);
      assert.equal(transmitted.ssh_pwauth, false);
      if (posts === 2) {
        assert.equal(body.snapshot_id, "snap");
        assert.equal(body.os_id, undefined);
      } else assert.equal(body.os_id, 2284);
      assert.ok(
        !Object.hasOwn(transmitted, "ssh_genkeytypes") ||
          transmitted.ssh_genkeytypes.length > 0,
        "Create and restore payloads must pass cloud-init's key-generation schema",
      );
      server = {
        id: "vm-42",
        plan: "vc2-2c-4gb",
        disk: 80,
        tags: body.tags,
        volumes: [],
        main_ip: "192.0.2.1",
      };
      if (fail) {
        fail = false;
        throw Object.assign(Error("lost"), { code: "outcome_unknown" });
      }
      return { instance: server };
    },
    async getServer() {
      return server;
    },
    async waitStatus() {
      return server;
    },
  };
  const life = new Lifecycle(store, api);
  await assert.rejects(life.create(id, "ssh-ed25519 AAAA"), {
    code: "outcome_unknown",
  });
  const pin = store.get(id).pending.hostIdentity.publicKey;
  const recovered = await new Lifecycle(new Store(store.directory), api).create(
    id,
    "ssh-ed25519 AAAA",
  );
  assert.equal(posts, 1);
  assert.equal(recovered.vm.hostKey, pin);
  assert.equal(recovered.vm.hostKeySource, "provisioned");
  assert.equal(recovered.vm.ip, "192.0.2.1");
  server = null;
  await store.update(id, (r) => ({
    ...r,
    vm: null,
    snapshot: {
      imageId: "snap",
      plan: "vc2-2c-4gb",
      description: "saved",
      disk: 80,
    },
    pending: null,
  }));
  api.getImage = async () => ({
    id: "snap",
    status: "complete",
    os_id: 2284,
    size: 123,
    description: "saved",
  });
  const restored = await life.create(id, "ssh-ed25519 AAAA");
  assert.notEqual(restored.vm.hostKey, pin);
  assert.equal(posts, 2);
});

test("unknown create without an observable match and ambiguous matches never allocate another instance", async (t) => {
  const store = new Store(temporary(t)),
    id = randomUUID();
  await store.create({
    id,
    namespace: "test",
    localRoot: temporary(t),
    config: { plan: "vc2-2c-4gb", region: "syd", osId: 2284 },
    vm: null,
    pending: { kind: "create", operation: randomUUID(), attempted: true },
  });
  let matches = [];
  const api = {
    find: async () => matches,
    request: () => assert.fail("No mutation after unknown create"),
  };
  const life = new Lifecycle(store, api);
  await assert.rejects(life.create(id, "ssh-ed25519 AAAA"), {
    code: "outcome_unknown",
  });
  matches = [{ id: "vm-a" }, { id: "vm-b" }];
  await assert.rejects(life.create(id, "ssh-ed25519 AAAA"), {
    code: "ambiguous_operation",
  });
  assert.equal(store.get(id).vm, null);
});
