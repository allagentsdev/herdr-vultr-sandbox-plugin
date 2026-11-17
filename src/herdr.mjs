import { fileURLToPath } from "node:url";
import { PLUGIN_ID } from "./constants.mjs";
import { runSync } from "./process.mjs";
import { PluginError } from "./result.mjs";

export function herdrBinary(env = process.env) {
  return env.HERDR_BIN_PATH || "herdr";
}

export function pluginPaneArgs(entrypoint, context, options = {}) {
  if (!context.focused_pane_id && !options.targetPaneId)
    throw new PluginError(
      "caller_required",
      "Explicit source pane is required; focused pane fallback is disabled.",
    );
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    PLUGIN_ID,
    "--entrypoint",
    entrypoint,
  ];
  const placement = options.placement;
  if (placement) args.push("--placement", placement);
  if (placement === "tab" && (options.workspaceId ?? context.workspace_id)) {
    args.push("--workspace", options.workspaceId ?? context.workspace_id);
  }
  if (
    ["split", "zoomed", "popup"].includes(placement) &&
    (options.targetPaneId ?? context.focused_pane_id)
  ) {
    args.push("--target-pane", options.targetPaneId ?? context.focused_pane_id);
  }
  if (options.cwd) args.push("--cwd", options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new PluginError(
        "invalid_pane_env",
        `Invalid pane environment key: ${key}.`,
      );
    }
    args.push("--env", `${key}=${value}`);
  }
  args.push(options.focus === false ? "--no-focus" : "--focus");
  return args;
}

export function openPluginPane(entrypoint, context, options = {}) {
  const args = pluginPaneArgs(entrypoint, context, options);
  return runSync(herdrBinary(options.processEnv), args, {
    env: options.processEnv,
  });
}

export function currentPane(env = process.env) {
  try {
    const value = JSON.parse(
      runSync(herdrBinary(env), ["pane", "current", "--current"], { env })
        .stdout,
    );
    return (
      value.result?.pane?.pane_id ?? value.result?.pane_id ?? env.HERDR_PANE_ID
    );
  } catch {
    return env.HERDR_PANE_ID;
  }
}
export function reportSession(id, paneId, kind, env = process.env) {
  if (!["codex", "claude", "opencode", "gemini", "generic"].includes(kind))
    return false;
  const entry = new URL("./action.mjs", import.meta.url);
  const result = runSync(
    herdrBinary(env),
    [
      "pane",
      "report-agent-session",
      paneId,
      "--source",
      "vultr.sandbox",
      "--agent",
      kind,
      "--session-start-source",
      "plugin-worker",
      "--",
      "node",
      fileURLToPath(entry),
      "reconnect",
      "--worker",
      id,
    ],
    { env, check: false },
  );
  return result.status === 0;
}
export function focusPluginPane(paneId, env = process.env) {
  return (
    runSync(herdrBinary(env), ["plugin", "pane", "focus", paneId], {
      env,
      check: false,
    }).status === 0
  );
}
