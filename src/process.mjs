import { spawnSync } from "node:child_process";

import { PluginError } from "./result.mjs";

export function runSync(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.encoding === null ? null : "utf8",
    input: options.input,
    timeout: options.timeout,
    killSignal: options.killSignal,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    stdio: options.stdio ?? [
      options.input === undefined ? "ignore" : "pipe",
      "pipe",
      "pipe",
    ],
  });
  if (result.error?.code === "ETIMEDOUT")
    throw new PluginError(
      "command_timeout",
      `${command} exceeded its deadline; any remote outcome remains uncertain.`,
    );
  if (result.error) {
    throw new PluginError(
      "command_start_failed",
      `${command} could not start: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  if (options.check !== false && result.status !== 0) {
    throw new PluginError(
      "command_failed",
      `${command} exited with ${result.status}.`,
    );
  }
  return {
    status: result.status ?? 1,
    stdout:
      options.encoding === null ? result.stdout : String(result.stdout ?? ""),
    stderr:
      options.encoding === null ? result.stderr : String(result.stderr ?? ""),
  };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
