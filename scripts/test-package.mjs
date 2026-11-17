import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("../", import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vultr-package-"));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: directory,
    encoding: "utf8",
    timeout: 60000,
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
try {
  const pack = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", directory], {
      cwd: source,
    }),
  )[0];
  assert.ok(
    pack.files.every(
      ({ path: p }) =>
        !/(^|\/)(node_modules|\.git|\.env|coverage)(\/|$)/.test(p),
    ),
  );
  run("tar", ["-xzf", path.join(directory, pack.filename), "-C", directory]);
  const installed = path.join(directory, "package");
  run("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: installed });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(HERDR_|VULTR_)/.test(k)),
  );
  Object.assign(env, {
    HERDR_PLUGIN_STATE_DIR: path.join(directory, "state"),
    HERDR_PLUGIN_CONFIG_DIR: path.join(directory, "config"),
    HERDR_SOCKET_PATH: path.join(directory, "unused.sock"),
    HERDR_PANE_ID: "package:p1",
    HERDR_SESSION: "package-smoke",
  });
  const output = run(
    process.execPath,
    [path.join(installed, "src/action.mjs"), "list"],
    { env },
  );
  const receipt = JSON.parse(output.trim().replace(/^VULTR_RESULT /, ""));
  assert.equal(receipt.plugin, "vultr.sandbox");
  assert.equal(receipt.status, "observed");
  assert.deepEqual(receipt.workers, []);
  // Runtime imports need no development dependency or current plugin cwd.
  assert.ok(fs.existsSync(path.join(installed, "examples/config.json")));
  console.log(
    JSON.stringify({
      status: "passed",
      package: pack.filename,
      files: pack.files.length,
      productionInstall: true,
      absoluteEntrypoint: true,
      arbitraryCwd: true,
      noCredentials: true,
      providerRequests: 0,
    }),
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
