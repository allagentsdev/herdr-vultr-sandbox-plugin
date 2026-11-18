import { PluginError } from "./result.mjs";
import { shellQuote as q } from "./process.mjs";
export const COMPOUND_COMMIT = "d8f8e03237bded06e77bcb3930b43ef841e7eeda";
const PROFILE_FIELDS = new Set([
  "title",
  "installationCommand",
  "launchCommand",
  "resumeCommand",
  "versionCommand",
  "expectedVersion",
  "authenticationMode",
  "authenticationCommand",
  "authenticationCheck",
  "herdrDetectionIdentifier",
  "interactiveTTY",
  "resumeSupported",
]);
const fail = (message) => {
  throw new PluginError("invalid_config", message);
};
export function validateCustomProfiles(profiles = {}) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles))
    fail("customAgents must be an object.");
  for (const [kind, p] of Object.entries(profiles)) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(kind) ||
      ["codex", "codex-compound", "claude-code", "opencode"].includes(kind) ||
      !p ||
      typeof p !== "object" ||
      Array.isArray(p)
    )
      fail("Invalid custom agent kind/profile.");
    for (const key of Object.keys(p))
      if (!PROFILE_FIELDS.has(key))
        fail(`Unsupported custom agent field: ${key}.`);
    for (const key of PROFILE_FIELDS) {
      if (
        [
          "resumeCommand",
          "authenticationCommand",
          "authenticationCheck",
        ].includes(key) &&
        p[key] === undefined
      )
        continue;
      if (
        ["interactiveTTY", "resumeSupported"].includes(key)
          ? typeof p[key] !== "boolean"
          : typeof p[key] !== "string" || !p[key].trim()
      )
        fail(`Custom agent requires ${key}.`);
    }
    if (!p.interactiveTTY || !p.resumeSupported)
      fail("Terminal workers require interactiveTTY and resumeSupported.");
    if (!/^[a-z][a-z0-9-]*$/.test(p.herdrDetectionIdentifier))
      fail("Invalid Herdr detection identifier.");
  }
  return structuredClone(profiles);
}
export function compoundInstallScript(state) {
  const home = state + "/agent-home",
    codex = state + "/agent-tools/node_modules/.bin/codex";
  return `set -eu\nmkdir -p ${q(home)}\nif [ ! -e ${q(home + "/compound-engineering.config.toml")} ]; then printf '# Public Compound profile; no permission overrides.\\n' > ${q(home + "/compound-engineering.config.toml")}; fi\nexport CODEX_HOME=${q(home)}\n${q(codex)} plugin marketplace add https://github.com/EveryInc/compound-engineering-plugin.git --ref ${q(COMPOUND_COMMIT)}\n${q(codex)} plugin add compound-engineering@compound-engineering-plugin`;
}
export function resolveAdapter(
  config = {},
  { existing = false, workerId = "worker" } = {},
) {
  const kind =
    config.agentKind ?? (config.adapter ? "custom-command" : "codex");
  if (!existing && config.allowCandidateAgents !== true)
    throw new PluginError(
      "candidate_agent",
      "Vultr agent conformance is pending. Set allowCandidateAgents=true to explicitly run a candidate. Existing workers remain recoverable.",
    );
  const state = `/var/lib/herdr/workers/${workerId}`,
    tools = state + "/agent-tools",
    home = state + "/agent-home";
  const args = (config.agentArgs?.[kind] ?? []).map(q).join(" ");
  const capabilities = {
    interactiveTTY: true,
    resumeSupported: true,
    authentication: "remote-only",
    herdrDetectionKind: "codex",
  };
  const base = {
    kind,
    title: kind,
    version: null,
    conformance: "pending-live",
    capabilities,
    install: "",
    login: "exec bash -l",
    versionCommand: null,
    activity: config.adapter?.activity ?? "",
    quiesce: config.adapter?.quiesce ?? "",
    restart: config.adapter?.restart ?? "",
  };
  if (kind === "custom-command") {
    if (
      !existing &&
      (!config.adapter?.launch ||
        !config.adapter.resume ||
        !config.adapter.authCheck)
    )
      fail("Legacy adapter requires launch, resume and authCheck.");
    return {
      ...base,
      ...config.adapter,
      capabilities: {
        ...capabilities,
        herdrDetectionKind:
          config.herdrDetectionIdentifier ??
          legacyDetection(config.adapter.launch),
      },
      title: "Saved command adapter",
    };
  }
  if (config.customAgents?.[kind]) {
    const p = validateCustomProfiles({ [kind]: config.customAgents[kind] })[
      kind
    ];
    return {
      ...base,
      title: p.title,
      version: p.expectedVersion,
      install: p.installationCommand,
      launch: [p.launchCommand, args].filter(Boolean).join(" "),
      resume: [p.resumeCommand ?? p.launchCommand, args]
        .filter(Boolean)
        .join(" "),
      login: p.authenticationCommand ?? "exec bash -l",
      authCheck: p.authenticationCheck ?? null,
      versionCommand: p.versionCommand,
      capabilities: {
        ...capabilities,
        herdrDetectionKind: p.herdrDetectionIdentifier,
        authentication: p.authenticationMode,
        automaticResume: !!p.resumeCommand,
      },
    };
  }
  const specs = {
    codex: { version: "0.169.0", pkg: "@openai/codex", bin: "codex" },
    "codex-compound": {
      version: "0.169.0",
      pkg: "@openai/codex",
      bin: "codex",
    },
    "claude-code": {
      version: "2.1.220",
      pkg: "@anthropic-ai/claude-code",
      bin: "claude",
    },
    opencode: { version: "1.18.9", pkg: "opencode-ai", bin: "opencode" },
  };
  const s = specs[kind];
  if (!s) fail("Unsupported agentKind.");
  const bin = q(tools + "/node_modules/.bin/" + s.bin);
  let prefix,
    login,
    check,
    resume,
    extra = "";
  if (kind.startsWith("codex")) {
    prefix = `env CODEX_HOME=${q(home)}`;
    login = `${bin} login --device-auth`;
    check = `${bin} login status`;
    resume = `${bin} resume --last`;
    if (kind === "codex-compound") {
      extra = " --profile compound-engineering";
      resume = `${bin}${extra} resume --last`;
    }
  } else if (kind === "claude-code") {
    prefix = `env DISABLE_AUTOUPDATER=1 CLAUDE_CONFIG_DIR=${q(home)}`;
    login = `${bin} auth login`;
    check = `${bin} auth status`;
    resume = `${bin} --continue`;
    capabilities.herdrDetectionKind = "claude";
  } else {
    prefix = `env XDG_DATA_HOME=${q(home + "/share")} XDG_CONFIG_HOME=${q(home + "/config")}`;
    login = `${bin} auth login`;
    check = `${bin} auth list 2>/dev/null | grep -Eiq '(OAuth|API key|OpenAI|Anthropic)'`;
    resume = `${bin} --continue`;
    capabilities.herdrDetectionKind = "opencode";
  }
  const runtime = state + "/runtime";
  const nodeInstall = `if [ ! -x ${q(runtime + "/bin/node")} ]; then\ncase "$(uname -m)" in x86_64) node_arch=x64;; aarch64) node_arch=arm64;; *) exit 1;; esac\nnode_archive="node-v24.22.3-linux-$node_arch.tar.xz"\nnode_temp="$(mktemp -d)"\ncurl --fail --silent --show-error "https://nodejs.org/dist/v24.22.3/$node_archive" -o "$node_temp/$node_archive"\ncurl --fail --silent --show-error https://nodejs.org/dist/v24.22.3/SHASUMS256.txt -o "$node_temp/SHASUMS256.txt"\n(cd "$node_temp"; grep "  $node_archive$" SHASUMS256.txt | sha256sum --check --status)\nmkdir -p ${q(runtime)}\ntar -xJf "$node_temp/$node_archive" --strip-components=1 -C ${q(runtime)}\nrm -rf -- "$node_temp"\nfi\nexport PATH=${q(runtime + "/bin")}:"$PATH"`;
  prefix =
    `env PATH=${q(runtime + "/bin")}:"$PATH" ` + prefix.replace(/^env /, "");
  const installation = `${nodeInstall}\nmkdir -p ${q(tools)} ${q(home)}\nnpm install --prefix ${q(tools)} --no-audit --no-fund ${q(s.pkg + "@" + s.version)}${kind === "codex-compound" ? "\n" + compoundInstallScript(state) : ""}`;
  return {
    ...base,
    version: s.version,
    install: installation,
    login: `${prefix} ${login}`,
    authCheck: `${prefix} ${check}`,
    launch: `${prefix} ${bin}${extra}${args ? " " + args : ""}`,
    resume: `${prefix} ${resume}${args ? " " + args : ""}`,
    versionCommand: `${prefix} ${bin} --version`,
    codexHome: kind.startsWith("codex") ? home : null,
  };
}
export function recordAdapter(record) {
  return (
    record.agentAdapter ??
    resolveAdapter(record.config, { existing: true, workerId: record.id })
  );
}
export function adapterCommands(adapter) {
  return Object.fromEntries(
    [
      "activity",
      "install",
      "authCheck",
      "launch",
      "resume",
      "quiesce",
      "restart",
    ].map((key) => [key, adapter[key] ?? ""]),
  );
}

function legacyDetection(command = "") {
  const words = command.split(/[\s/'"]+/);
  if (words.some((word) => word === "codex" || word === "codex-compound"))
    return "codex";
  if (words.includes("claude")) return "claude";
  if (words.includes("opencode")) return "opencode";
  return "generic";
}
