import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  guestInstallCommand,
  GUEST_HERDR_RELEASE,
} from "../src/guest-herdr.mjs";
import { runSync, shellQuote as q } from "../src/process.mjs";
import { temporary, write } from "./helpers.mjs";

test("guest installer verifies downloaded bytes before replacing the installed binary", (t) => {
  const dir = temporary(t),
    bin = path.join(dir, "bin"),
    state = path.join(dir, "worker state's"),
    downloaded = path.join(dir, "download"),
    installed = state + "/tools/herdr";
  fs.mkdirSync(bin);
  fs.mkdirSync(state + "/tools", { recursive: true });
  // Synthetic download transport; use its actual bytes/hash to exercise sha256sum.
  const bytes = Buffer.from("downloaded fixture binary\n"),
    digest = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(downloaded, bytes);
  write(
    bin,
    "curl",
    `#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\ncp ${q(downloaded)} "$2"\n`,
    0o755,
  );
  const command = guestInstallCommand(state)
    .replace(GUEST_HERDR_RELEASE.x86_64.sha256, digest)
    .replace(GUEST_HERDR_RELEASE.aarch64.sha256, digest);
  const run = () =>
    runSync("bash", ["-c", command], {
      env: { ...process.env, PATH: bin + ":" + process.env.PATH },
      check: false,
    });
  assert.equal(run().status, 0);
  assert.deepEqual(fs.readFileSync(installed), bytes);
  assert.equal(fs.statSync(installed).mode & 0o777, 0o755);
  fs.writeFileSync(downloaded, "corrupt transport bytes");
  assert.notEqual(run().status, 0);
  assert.deepEqual(fs.readFileSync(installed), bytes);
});
