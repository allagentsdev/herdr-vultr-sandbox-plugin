import { stripVTControlCharacters } from "node:util";
import { PLUGIN_ID } from "./constants.mjs";

export class PluginError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.code = code;
  }
}
export function safeText(value, env = process.env) {
  let text = stripVTControlCharacters(String(value)).replace(
    // eslint-disable-next-line no-control-regex -- Prevent remote text from controlling the review terminal.
    /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    "",
  );
  for (const [key, secret] of Object.entries(env)) {
    if (
      /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) &&
      secret?.length >= 4
    )
      text = text.replaceAll(secret, "[redacted]");
  }
  return text;
}
export function errorMessage(error) {
  return error instanceof PluginError
    ? safeText(error.message)
    : "Operation failed. Check authentication, provider availability, and retained association state; no credentials are logged.";
}
export function emitResult(action, status, data = {}) {
  const result = {
    schemaVersion: 1,
    plugin: PLUGIN_ID,
    action,
    status,
    at: new Date().toISOString(),
    ...data,
  };
  process.stdout.write(`VULTR_RESULT ${safeText(JSON.stringify(result))}\n`);
  return result;
}
export function emitFailure(action, error) {
  return emitResult(action, "failed", {
    code: error instanceof PluginError ? error.code : "unexpected_error",
    message: errorMessage(error),
  });
}
