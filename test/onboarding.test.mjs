import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { saveConfiguration, inspectConfiguration } from "../src/onboarding.mjs";
import { runSync } from "../src/process.mjs";
import { temporary, write } from "./helpers.mjs";
test("onboarding stores only credential paths and checks provider access without allocating compute", async (t) => {
  const root = temporary(t),
    dir = path.join(root, "config");
  write(root, "token", "synthetic-token", 0o600);
  runSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    path.join(root, "key"),
  ]);
  const c = {
    tokenFile: path.join(root, "token"),
    sshPrivateKey: path.join(root, "key"),
    sshPublicKey: path.join(root, "key.pub"),
    agentKind: "codex",
    allowCandidateAgents: true,
  };
  saveConfiguration(dir, c);
  assert.equal(fs.statSync(path.join(dir, "config.json")).mode & 0o777, 0o600);
  const text = fs.readFileSync(path.join(dir, "config.json"), "utf8");
  assert.ok(!text.includes("synthetic-token"));
  assert.ok(!text.includes("synthetic-private-key"));
  const calls = [];
  const result = await inspectConfiguration(dir, {
    api: {
      async request(method, url) {
        calls.push({ method, url });
        return { servers: [] };
      },
    },
  });
  assert.equal(result.readAccess, "confirmed");
  assert.equal(result.computeAllocated, false);
  assert.deepEqual(calls, [{ method: "GET", url: "/instances?per_page=1" }]);
});
test("onboarding distinguishes missing configuration and provider failures without manufacturing a login success", async (t) => {
  const dir = temporary(t);
  await assert.rejects(inspectConfiguration(dir), { code: "config_required" });
  write(dir, "token", "synthetic-token", 0o600);
  runSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    path.join(dir, "key"),
  ]);
  saveConfiguration(path.join(dir, "config"), {
    tokenFile: path.join(dir, "token"),
    sshPrivateKey: path.join(dir, "key"),
    sshPublicKey: path.join(dir, "key.pub"),
  });
  await assert.rejects(
    inspectConfiguration(path.join(dir, "config"), {
      api: {
        async request() {
          throw Object.assign(Error("rejected"), { code: "provider_rejected" });
        },
      },
    }),
    { code: "provider_rejected" },
  );
});

test("onboarding rejects mismatched or encrypted client keys before provider access or billing", async (t) => {
  const { clientPublicKey } = await import("../src/ssh.mjs"),
    dir = temporary(t);
  for (const [name, pass] of [
    ["first", ""],
    ["second", ""],
    ["encrypted", "test-only-passphrase"],
  ])
    runSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      pass,
      "-f",
      path.join(dir, name),
    ]);
  assert.throws(
    () =>
      clientPublicKey({
        sshPrivateKey: path.join(dir, "first"),
        sshPublicKey: path.join(dir, "second.pub"),
      }),
    { code: "client_key_mismatch" },
  );
  assert.throws(
    () =>
      clientPublicKey({
        sshPrivateKey: path.join(dir, "encrypted"),
        sshPublicKey: path.join(dir, "encrypted.pub"),
      }),
    { code: "client_key_unusable" },
  );
  write(dir, "token", "synthetic-token", 0o600);
  saveConfiguration(path.join(dir, "config"), {
    tokenFile: path.join(dir, "token"),
    sshPrivateKey: path.join(dir, "first"),
    sshPublicKey: path.join(dir, "second.pub"),
  });
  await assert.rejects(
    inspectConfiguration(path.join(dir, "config"), {
      api: {
        request: () =>
          assert.fail("No provider request before client identity matches"),
      },
    }),
    { code: "client_key_mismatch" },
  );
});
