import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSync } from "../src/process.mjs";
export function temporary(t, prefix = "vultr-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}
export function git(root, args, options = {}) {
  return runSync("git", args, { cwd: root, ...options });
}
export function repository(t) {
  const root = temporary(t, "vultr repo ");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test"]);
  return root;
}
export function write(root, name, data = "content\n", mode = 0o644) {
  const dest = path.join(root, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
  fs.chmodSync(dest, mode);
}
