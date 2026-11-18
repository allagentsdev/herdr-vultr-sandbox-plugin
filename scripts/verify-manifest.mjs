import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { ACTIONS } from "../src/constants.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = TOML.parse(
  fs.readFileSync(path.join(root, "herdr-plugin.toml"), "utf8"),
);
assert.equal(manifest.id, "vultr.sandbox");
assert.equal(manifest.min_herdr_version, "0.9.5");
assert.deepEqual(manifest.platforms, ["linux"]);
assert.deepEqual(manifest.actions.map((x) => x.id).sort(), [...ACTIONS].sort());
assert.deepEqual(manifest.build, [{ command: ["npm", "ci", "--omit=dev"] }]);
for (const item of [...manifest.actions, ...manifest.panes]) {
  assert.deepEqual(item.command.slice(0, 2), ["sh", "-c"]);
  assert.match(
    item.command[2],
    /^exec node "\$HERDR_PLUGIN_ROOT\/src\/(action|pane)\.mjs"$/,
  );
  const name = item.command[2].includes("action.mjs") ? "action" : "pane";
  assert.ok(fs.statSync(path.join(root, "src", name + ".mjs")).isFile());
}
assert.deepEqual(manifest.startup, [
  {
    command: [
      "sh",
      "-c",
      'exec node "$HERDR_PLUGIN_ROOT/src/expiry-startup.mjs"',
    ],
  },
]);
assert.ok(fs.statSync(path.join(root, "src/expiry-startup.mjs")).isFile());
for (const a of manifest.actions)
  assert.deepEqual(a.contexts, ["workspace", "pane"]);
console.log(
  `Manifest: Linux hosts, ${ACTIONS.length} actions, absolute plugin-root entrypoints and npm install hook verified.`,
);
