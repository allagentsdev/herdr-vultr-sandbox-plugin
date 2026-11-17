import fs from "node:fs";
import path from "node:path";
import { loadConfig, readPrivate, validateConfig } from "./config.mjs";
import { atomicJson } from "./state.mjs";
import { Cloud } from "./provider.mjs";
import { clientPublicKey } from "./ssh.mjs";
import { PluginError } from "./result.mjs";
export function saveConfiguration(directory, raw, { overwrite = false } = {}) {
  if (
    !path.isAbsolute(directory) ||
    (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())
  )
    throw new PluginError(
      "invalid_config",
      "Configuration directory must be an absolute regular directory.",
    );
  const c = validateConfig(raw),
    file = path.join(directory, "config.json");
  if (fs.existsSync(file) && !overwrite)
    throw new PluginError(
      "config_exists",
      "Configuration exists; explicit replacement is required.",
    );
  for (const key of ["tokenFile", "sshPrivateKey", "sshPublicKey"])
    if (!c[key])
      throw new PluginError(
        "config_required",
        `Configure the ${key} file path.`,
      );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  atomicJson(file, c);
  return c;
}
export async function inspectConfiguration(directory, { api } = {}) {
  let c;
  try {
    c = loadConfig({ HERDR_PLUGIN_CONFIG_DIR: directory });
  } catch (e) {
    if (e.code === "ENOENT")
      throw new PluginError(
        "config_required",
        "Create host-private config.json and credential files before starting a worker.",
      );
    throw e;
  }
  clientPublicKey(c);
  const cloud = api ?? new Cloud(readPrivate(c.tokenFile));
  await cloud.request("GET", "/instances?per_page=1");
  return {
    configured: true,
    sshClientKey: "matched",
    readAccess: "confirmed",
    writeAccess: "not-proven",
    computeAllocated: false,
    plan: c.plan,
    region: c.region,
    hostKeyMode: c.hostKeyMode,
    agentKind: c.agentKind,
    agentConformance: "pending-live",
  };
}
