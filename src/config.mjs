import fs from "node:fs";
import path from "node:path";
import { PluginError } from "./result.mjs";
import { validateCustomProfiles } from "./adapters.mjs";
export function safeRelative(p) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !path.isAbsolute(p) &&
    !p.includes("\\") &&
    !p.includes("\0") &&
    p.split("/").every((x) => x && x !== "." && x !== "..")
  );
}
export function validateConfig(raw = {}) {
  const allowed = new Set([
    "osId",
    "plan",
    "region",
    "maxFiles",
    "maxFileBytes",
    "maxUploadBytes",
    "excludedPaths",
    "uploadExcludes",
    "adapter",
    "tokenFile",
    "sshPrivateKey",
    "sshPublicKey",
    "agentKind",
    "agentArgs",
    "customAgents",
    "allowCandidateAgents",
    "hostKeyMode",
    "herdrDetectionIdentifier",
  ]);
  const bad = () => {
    throw new PluginError(
      "invalid_config",
      "Unknown, conflicting or invalid configuration field. See README.",
    );
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad();
  for (const key of Object.keys(raw)) if (!allowed.has(key)) bad();
  if (raw.excludedPaths !== undefined && raw.uploadExcludes !== undefined)
    bad();
  if (raw.adapter !== undefined) {
    if (
      !raw.adapter ||
      typeof raw.adapter !== "object" ||
      Array.isArray(raw.adapter)
    )
      bad();
    for (const key of Object.keys(raw.adapter))
      if (
        ![
          "install",
          "authCheck",
          "launch",
          "resume",
          "quiesce",
          "restart",
        ].includes(key)
      )
        bad();
  }
  if (
    raw.agentKind !== undefined &&
    (typeof raw.agentKind !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(raw.agentKind))
  )
    bad();
  if (
    raw.allowCandidateAgents !== undefined &&
    typeof raw.allowCandidateAgents !== "boolean"
  )
    bad();
  if (raw.agentArgs !== undefined) {
    if (
      !raw.agentArgs ||
      typeof raw.agentArgs !== "object" ||
      Array.isArray(raw.agentArgs)
    )
      bad();
    for (const args of Object.values(raw.agentArgs))
      if (
        !Array.isArray(args) ||
        args.some((a) => typeof a !== "string" || a.includes("\0"))
      )
        bad();
  }
  validateCustomProfiles(raw.customAgents ?? {});
  if (raw.hostKeyMode !== undefined && raw.hostKeyMode !== "provisioned") bad();
  const c = {
    osId: 2284,
    plan: "vc2-2c-4gb",
    region: "syd",
    maxFiles: 20000,
    maxFileBytes: 10 * 1024 * 1024,
    maxUploadBytes: 100 * 1024 * 1024,
    excludedPaths: raw.uploadExcludes ?? [],
    agentKind: raw.agentKind ?? (raw.adapter ? "custom-command" : "codex"),
    agentArgs: {},
    customAgents: {},
    allowCandidateAgents: false,
    hostKeyMode: "provisioned",
    adapter: {
      install: "",
      authCheck: "command -v codex >/dev/null && codex login status",
      launch: "codex",
      resume: "codex resume --last",
      quiesce: "",
      restart: "",
    },
    ...raw,
  };
  delete c.uploadExcludes;
  c.adapter = {
    install: "",
    authCheck: "",
    launch: "",
    resume: "",
    quiesce: "",
    restart: "",
    ...c.adapter,
  };
  const invalid = () => {
    throw new PluginError(
      "invalid_config",
      "Invalid configuration. See README configuration contract.",
    );
  };
  for (const k of ["maxFiles", "maxFileBytes", "maxUploadBytes"])
    if (!Number.isSafeInteger(c[k]) || c[k] <= 0) invalid();
  if (
    !Array.isArray(c.excludedPaths) ||
    c.excludedPaths.some(
      (p) =>
        typeof p !== "string" ||
        !(
          /^[*]\.[^/*]+$/.test(p) ||
          (safeRelative(p.replace(/\/\*\*$|\/$/, "")) &&
            !p.replace(/\/\*\*$/, "").includes("*"))
        ),
    )
  )
    invalid();
  for (const k of ["plan", "region"])
    if (typeof c[k] !== "string" || !/^[a-z0-9.-]+$/.test(c[k])) invalid();
  if (!/^vc2-[1-9][0-9]*c-[1-9][0-9]*gb$/.test(c.plan) || c.osId !== 2284)
    invalid();
  for (const k of [
    "install",
    "authCheck",
    "launch",
    "resume",
    "quiesce",
    "restart",
  ])
    if (typeof c.adapter[k] !== "string") invalid();
  for (const k of ["tokenFile", "sshPrivateKey", "sshPublicKey"])
    if (c[k] !== undefined && (!path.isAbsolute(c[k]) || c[k].includes("\n")))
      invalid();
  return c;
}
export function assertPrivateFile(file) {
  const s = fs.lstatSync(file);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    s.uid !== process.getuid()
  )
    throw new PluginError(
      "private_file_required",
      "Credential/config files must be owned regular files with mode 0600.",
    );
  return s;
}
export function readPrivate(file) {
  assertPrivateFile(file);
  return fs.readFileSync(file, "utf8").trim();
}
export function loadConfig(env = process.env) {
  const dir = env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir || !path.isAbsolute(dir))
    throw new PluginError(
      "config_required",
      "HERDR_PLUGIN_CONFIG_DIR must be absolute. Create config.json there (see README).",
    );
  const c = validateConfig(
    JSON.parse(readPrivate(path.join(dir, "config.json"))),
  );
  for (const k of ["tokenFile", "sshPrivateKey", "sshPublicKey"])
    if (!c[k])
      throw new PluginError(
        "config_required",
        `Configure ${k} in host-private config.json.`,
      );
  assertPrivateFile(c.sshPrivateKey);
  return c;
}
