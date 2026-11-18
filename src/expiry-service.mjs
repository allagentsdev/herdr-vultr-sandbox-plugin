import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson } from "./state.mjs";
import { runSync } from "./process.mjs";
import { PluginError } from "./result.mjs";

const entrypoint = fileURLToPath(
  new URL("expiry-controller.mjs", import.meta.url),
);
const launcher = `import fs from 'node:fs';\nimport {pathToFileURL} from 'node:url';\nconst runtime = JSON.parse(fs.readFileSync(new URL('./expiry-runtime.json', import.meta.url), 'utf8'));\nawait (await import(pathToFileURL(runtime.entrypoint))).runController(runtime.directory);\n`;
const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const unitQuote = (value) =>
  '"' +
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$") +
  '"';
export function serviceDefinition(
  directory,
  {
    platform = process.platform,
    home = os.homedir(),
    node = process.execPath,
    uid = process.getuid(),
  } = {},
) {
  for (const value of [directory, home, node])
    if (!path.isAbsolute(value) || /[\r\n\0]/.test(value))
      throw new PluginError(
        "invalid_service_path",
        "Controller paths must be absolute and contain no line breaks.",
      );
  const name =
    "herdr-vultr-expiry-" +
    createHash("sha256").update(directory).digest("hex").slice(0, 16);
  const script = path.join(directory, "expiry-launcher.mjs");
  if (platform === "linux")
    return {
      name,
      file: path.join(home, ".config/systemd/user", name + ".service"),
      content: `[Unit]\nDescription=Herdr Vultr automatic snapshot and release\n[Service]\nType=simple\nExecStart=${unitQuote(node)} ${unitQuote(script)}\nRestart=always\nRestartSec=5\nUMask=0077\n[Install]\nWantedBy=default.target\n`,
      commands: [
        ["systemctl", ["--user", "daemon-reload"]],
        ["systemctl", ["--user", "enable", "--now", name + ".service"]],
      ],
    };
  if (platform === "darwin")
    return {
      name,
      file: path.join(home, "Library/LaunchAgents", name + ".plist"),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer></dict></plist>\n`,
      commands: [
        [
          "launchctl",
          [
            "bootstrap",
            `gui/${uid}`,
            path.join(home, "Library/LaunchAgents", name + ".plist"),
          ],
        ],
      ],
    };
  throw new PluginError(
    "unsupported_host",
    "Automatic hibernation needs Linux systemd user services or macOS launchd.",
  );
}
export function controllerStatus(store, now = Date.now()) {
  try {
    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(store.directory, "expiry-controller.json"),
        "utf8",
      ),
    );
    if (!Number.isSafeInteger(receipt.pid) || receipt.pid <= 0)
      return { healthy: false, heartbeat: receipt.heartbeat };
    process.kill(receipt.pid, 0);
    return {
      ...receipt,
      healthy:
        Number.isFinite(Date.parse(receipt.heartbeat)) &&
        now - Date.parse(receipt.heartbeat) < 20000,
    };
  } catch {
    return { healthy: false, heartbeat: null };
  }
}
export async function ensureController(
  store,
  { run = runSync, ...options } = {},
) {
  const definition = serviceDefinition(store.directory, options);
  const runtime = { entrypoint, directory: store.directory };
  atomicJson(path.join(store.directory, "expiry-runtime.json"), runtime);
  fs.writeFileSync(
    path.join(store.directory, "expiry-launcher.mjs"),
    launcher,
    { mode: 0o600 },
  );
  fs.mkdirSync(path.dirname(definition.file), { recursive: true, mode: 0o700 });
  const changed =
    !fs.existsSync(definition.file) ||
    fs.readFileSync(definition.file, "utf8") !== definition.content;
  if (changed)
    fs.writeFileSync(definition.file, definition.content, { mode: 0o600 });
  // bootstrap returns nonzero for an already loaded launch agent. Health below is authoritative.
  for (const [cmd, args] of definition.commands) {
    const result = run(cmd, args, { check: false, timeout: 10000 });
    if (result.status !== 0 && cmd !== "launchctl")
      throw new PluginError(
        "controller_unavailable",
        "Cannot start the host user service. No new compute was requested. Check systemctl --user and user-service availability.",
      );
  }
  for (let i = 0; i < 40; i++) {
    if (controllerStatus(store).healthy) return;
    await delay(250);
  }
  throw new PluginError(
    "controller_unavailable",
    "The expiry controller did not confirm readiness. No new compute was requested. Inspect the host user service; automatic release cannot run while this host is offline.",
  );
}
