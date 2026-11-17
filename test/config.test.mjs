import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.mjs";
test("Vultr Linux configuration uses explicit plan/region/OS and rejects foreign provider fields", () => {
  const c = validateConfig({ plan: "vc2-2c-4gb", region: "syd", osId: 2284 });
  assert.equal(c.osId, 2284);
  assert.equal(c.hostKeyMode, "provisioned");
  for (const raw of [
    { serverType: "cpx22" },
    { location: "nbg1" },
    { image: "ubuntu-24.04" },
    { osId: 1743 },
    { plan: "gpu" },
    { hostKeyMode: "console" },
    { region: "../x" },
  ])
    assert.throws(() => validateConfig(raw), { code: "invalid_config" });
});
