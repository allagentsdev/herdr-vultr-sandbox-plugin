import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.mjs";
import { resolveAdapter, compoundInstallScript } from "../src/adapters.mjs";
test("built-in terminal adapters are pinned candidates and fresh starts require explicit opt-in", () => {
  for (const kind of ["codex", "codex-compound", "claude-code", "opencode"]) {
    assert.throws(() => resolveAdapter(validateConfig({ agentKind: kind })), {
      code: "candidate_agent",
    });
    const a = resolveAdapter(
      validateConfig({ agentKind: kind, allowCandidateAgents: true }),
    );
    assert.equal(a.kind, kind);
    assert.equal(a.conformance, "pending-live");
    assert.ok(a.version);
    assert.ok(a.login);
    assert.ok(a.resume);
    assert.equal(a.capabilities.interactiveTTY, true);
  }
});
test("legacy saved profiles remain operable without importing current host config or claiming verification", () => {
  const c = {
    adapter: {
      install: "public installer",
      authCheck: "remote auth",
      launch: "/opt/custom/agent",
      resume: "resume agent",
      quiesce: "",
      restart: "",
    },
  };
  const a = resolveAdapter(c, { existing: true });
  assert.equal(a.launch, c.adapter.launch);
  assert.equal(a.conformance, "pending-live");
});
test("custom agent profile is strict, declarative, argument-safe and immutable in the worker config", () => {
  const profile = {
    title: "Custom",
    installationCommand: "install-public",
    launchCommand: "my-agent",
    resumeCommand: "my-agent resume",
    versionCommand: "my-agent --version",
    expectedVersion: "1.2.3",
    authenticationMode: "device-code",
    authenticationCommand: "my-agent login",
    authenticationCheck: "my-agent status",
    herdrDetectionIdentifier: "codex",
    interactiveTTY: true,
    resumeSupported: true,
  };
  const config = validateConfig({
    agentKind: "mine",
    allowCandidateAgents: true,
    customAgents: { mine: profile },
    agentArgs: { mine: ["a; echo unsafe"] },
  });
  const a = resolveAdapter(config);
  assert.match(a.launch, /'a; echo unsafe'/);
  assert.equal(a.version, "1.2.3");
  assert.throws(
    () =>
      validateConfig({
        customAgents: {
          mine: { ...profile, hostModule: "/private/profile.mjs" },
        },
      }),
    { code: "invalid_config" },
  );
});
test("public Compound bootstrap is pinned, isolated and does not reference host private profiles or auth", () => {
  const script = compoundInstallScript("/var/lib/herdr/workers/example");
  assert.match(script, /d8f8e03237bded06e77bcb3930b43ef841e7eeda/);
  assert.match(
    script,
    /https:\/\/github.com\/EveryInc\/compound-engineering-plugin/,
  );
  assert.match(script, /plugin marketplace add/);
  assert.match(
    script,
    /plugin add compound-engineering@compound-engineering-plugin/,
  );
  assert.match(script, /compound-engineering\.config\.toml/);
  assert.doesNotMatch(script, /\[profiles\./);
  assert.doesNotMatch(
    script,
    /christso|loqbooks|auth\.json|\.allagents|sshPrivateKey/,
  );
});
test("configuration rejects misspelled or conflicting safety and adapter keys", () => {
  for (const c of [
    { allowCandiateAgents: true },
    { excludedPaths: [], uploadExcludes: [] },
    { adapter: { launch: "x", resume: "x", authCheck: "x", instal: "typo" } },
  ])
    assert.throws(() => validateConfig(c), { code: "invalid_config" });
  assert.deepEqual(
    validateConfig({ uploadExcludes: ["private/**"] }).excludedPaths,
    ["private/**"],
  );
});
test("the reference nine-field custom profile remains accepted with explicit unverified auth semantics", () => {
  const profile = {
    title: "Terminal",
    installationCommand: "install-terminal",
    launchCommand: "terminal-agent",
    versionCommand: "terminal-agent --version",
    expectedVersion: "1.0.0",
    authenticationMode: "agent-managed",
    herdrDetectionIdentifier: "generic",
    interactiveTTY: true,
    resumeSupported: true,
  };
  const config = validateConfig({
    agentKind: "custom-terminal",
    allowCandidateAgents: true,
    customAgents: { "custom-terminal": profile },
  });
  const a = resolveAdapter(config);
  assert.equal(a.launch, "terminal-agent");
  assert.equal(a.authCheck, null);
  assert.equal(a.conformance, "pending-live");
  assert.equal(a.capabilities.automaticResume, false);
});

test("legacy named Codex Compound wrapper receives a supported foreground hint without changing saved commands", () => {
  const record = {
    config: {
      adapter: {
        launch: "env CODEX_HOME=/dedicated/home /opt/tools/codex-compound",
        resume: "custom resume",
        authCheck: "custom auth",
      },
    },
  };
  const a = resolveAdapter(record.config, {
    existing: true,
    workerId: "worker",
  });
  assert.equal(a.capabilities.herdrDetectionKind, "codex");
  assert.equal(a.launch, record.config.adapter.launch);
});
