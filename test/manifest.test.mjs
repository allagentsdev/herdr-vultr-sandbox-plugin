import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  contentExclusionReason,
  captureSnapshot,
  readSnapshot,
  pathExclusionReason,
} from "../src/manifest.mjs";
import { validateConfig } from "../src/config.mjs";
import { repository, temporary, git, write } from "./helpers.mjs";

test("snapshot preserves eligible dirty linked-worktree bytes without changing the index", (t) => {
  const main = repository(t);
  write(main, "source", "original\n");
  write(main, ".env", "private");
  write(main, "tracked-ignored", "omit");
  git(main, ["add", "."]);
  git(main, ["commit", "-qm", "base"]);
  const linked = path.join(temporary(t), "linked tree");
  git(main, ["worktree", "add", "-qb", "linked", linked]);
  write(linked, "source", "staged\n");
  git(linked, ["add", "source"]);
  write(linked, "source", "on disk\n");
  write(linked, ".gitignore", "tracked-ignored\n");
  write(linked, "odd \nname", Buffer.from([0, 255, 128, 1]), 0o755);
  write(linked, "empty", "");
  write(linked, "nested/.git", "gitdir: /secret");
  write(linked, "nested/no", "skip");
  write(linked, "private.pem", "secret");
  write(linked, ".env.example", "secret");
  fs.symlinkSync("/etc/passwd", path.join(linked, "escape"));
  fs.symlinkSync("source", path.join(linked, "internal"));
  const index = git(linked, ["diff", "--cached", "--binary"]).stdout;
  const snapshot = captureSnapshot(
    linked,
    validateConfig({}),
    path.join(temporary(t), "baseline"),
  );
  assert.equal(
    fs.readFileSync(path.join(snapshot.directory, "files/source"), "utf8"),
    "on disk\n",
  );
  assert.deepEqual(
    snapshot.files.map((f) => f.path),
    [".gitignore", "empty", "odd \nname", "source"],
  );
  assert.equal(
    snapshot.files.find((f) => f.path === "odd \nname").mode,
    "100755",
  );
  assert.equal(git(linked, ["diff", "--cached", "--binary"]).stdout, index);
  assert.equal(readSnapshot(snapshot.directory).digest, snapshot.digest);
  fs.writeFileSync(path.join(snapshot.directory, "files/source"), "tampered");
  assert.throws(() => readSnapshot(snapshot.directory), {
    code: "snapshot_corrupt",
  });
});
test("mandatory exclusions cannot be overridden and escaping paths fail", () => {
  const c = validateConfig({ excludedPaths: ["src/private/"] });
  for (const p of [
    ".git/config",
    "a/.Git/HEAD",
    ".env.sample",
    ".aws/credentials",
    "x/.npmrc",
    "a/id_ed25519",
    "x/key.pem",
    ".config/gcloud/token",
    "src/private/a",
    "node_modules/x",
  ])
    assert.ok(pathExclusionReason(p, c), p);
  for (const p of ["/tmp/x", "a/../../x", "a/./b", "a\\b", ""])
    assert.throws(() => pathExclusionReason(p, c));
});

test("additional exclusions support directory wildcards and extensions without weakening mandatory filters", (t) => {
  const root = repository(t),
    config = validateConfig({
      excludedPaths: ["private/**", "*.log", "local/only"],
    });
  for (const name of [
    "source.mjs",
    "private/source.mjs",
    "deep/run.log",
    "local/only",
    ".env.example",
  ])
    write(root, name, "fixture\n");
  const snapshot = captureSnapshot(
    root,
    config,
    path.join(temporary(t), "snapshot"),
  );
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ["source.mjs"],
  );
  assert.equal(pathExclusionReason("private-other/source.mjs", config), null);
  for (const pattern of [
    "*",
    "**/*.log",
    "a/*",
    "../**",
    "*.",
    "a/*.log",
    "a/**/b",
  ])
    assert.throws(() => validateConfig({ excludedPaths: [pattern] }), {
      code: "invalid_config",
    });
});
test("snapshot bounds and file replacement are fail closed", (t) => {
  const root = repository(t);
  write(root, "a", "12345");
  assert.throws(
    () =>
      captureSnapshot(
        root,
        validateConfig({ maxFileBytes: 4 }),
        path.join(temporary(t), "bounded"),
      ),
    { code: "snapshot_limit" },
  );
  const original = fs.readSync;
  let replaced = false;
  t.mock.method(fs, "readSync", (...args) => {
    const result = original(...args);
    if (!replaced) {
      replaced = true;
      fs.renameSync(path.join(root, "a"), path.join(root, "old"));
      write(root, "a", "other");
    }
    return result;
  });
  assert.throws(
    () =>
      captureSnapshot(
        root,
        validateConfig({}),
        path.join(temporary(t), "race"),
      ),
    { code: "snapshot_race" },
  );
});

test("valid nested repositories and submodule entries are skipped; empty worktrees remain valid", (t) => {
  const root = repository(t),
    directory = temporary(t);
  const empty = captureSnapshot(
    root,
    validateConfig({}),
    path.join(directory, "empty"),
  );
  assert.deepEqual(empty.files, []);
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  git(nested, ["init", "-q"]);
  write(nested, "source", "private nested source");
  write(root, "top", "source");
  git(root, ["add", "top"]);
  git(root, ["commit", "-qm", "top"]);
  const oid = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  git(root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${oid},submodule`,
  ]);
  fs.mkdirSync(path.join(root, "submodule"));
  write(root, "submodule/file", "submodule data");
  const snapshot = captureSnapshot(
    root,
    validateConfig({}),
    path.join(directory, "nested"),
  );
  assert.deepEqual(
    snapshot.files.map((f) => f.path),
    ["top"],
  );
  assert.ok(snapshot.excluded.some((f) => f.path === "nested"));
  assert.ok(snapshot.excluded.some((f) => f.path === "submodule"));
});

test("Git and Vultr CLI credential files are never eligible source", () => {
  const config = validateConfig({});
  for (const file of [
    ".git-credentials",
    ".hcloud/cli.toml",
    ".config/hcloud/cli.toml",
  ])
    assert.ok(pathExclusionReason(file, config), file);
});

test("recognizable registry, netrc, GitLab, temporary cloud and structured credentials are filtered inside ordinary filenames", () => {
  for (const text of [
    "glpat-" + "x".repeat(25),
    "ASIA" + "A".repeat(16),
    "sk_live_" + "x".repeat(25),
    "machine example.test login user password value",
    "//registry.npmjs.org/:_authToken=value",
    JSON.stringify({ auths: { registry: { auth: "encoded" } } }),
    JSON.stringify({ type: "service_account", private_key: "value" }),
  ])
    assert.equal(contentExclusionReason(Buffer.from(text)), "detected-secret");
});
