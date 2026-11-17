import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { compoundInstallScript } from "../src/adapters.mjs";
const binary = process.env.VULTR_CODEX_TEST_BIN;
if (!binary || !path.isAbsolute(binary))
  throw Error(
    "Set VULTR_CODEX_TEST_BIN to an actual Codex 0.169.0 binary; no host launcher/profile is used.",
  );
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vultr-codex-bootstrap-")),
  state = root + "/worker",
  home = state + "/agent-home";
const env = {
  PATH: process.env.PATH,
  HOME: root + "/empty-home",
  CODEX_HOME: home,
  XDG_CONFIG_HOME: root + "/config",
  XDG_CACHE_HOME: root + "/cache",
  XDG_STATE_HOME: root + "/state",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  TERM: "dumb",
};
fs.mkdirSync(env.HOME);
fs.mkdirSync(state + "/agent-tools/node_modules/.bin", { recursive: true });
fs.symlinkSync(binary, state + "/agent-tools/node_modules/.bin/codex");
function run(command, args) {
  const r = spawnSync(command, args, {
    env,
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(r.status, 0, (r.stderr || r.stdout).slice(-3000));
  return r.stdout;
}
try {
  assert.match(run(binary, ["--version"]), /0\.169\.0/);
  run("bash", ["-c", compoundInstallScript(state)]);
  run(binary, [
    "--profile",
    "compound-engineering",
    "debug",
    "prompt-input",
    "configuration-only fixture",
  ]);
  assert.ok(
    fs.existsSync(home + "/compound-engineering.config.toml"),
    "Modern named profile must exist.",
  );
  assert.doesNotMatch(
    fs.existsSync(home + "/config.toml")
      ? fs.readFileSync(home + "/config.toml", "utf8")
      : "",
    /\[profiles\./,
  );
  run("bash", ["-c", compoundInstallScript(state)]);
  const plugins = run(binary, ["plugin", "list", "--json"]);
  assert.match(plugins, /compound-engineering/);
  console.log(
    JSON.stringify({
      status: "passed",
      codex: "0.169.0",
      isolatedHome: true,
      modernProfile: true,
      publicPlugin: true,
      idempotent: true,
      authenticatedAgent: false,
      providerConformance: false,
    }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
