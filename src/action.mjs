let action = process.env.HERDR_PLUGIN_ACTION_ID ?? null;
try {
  const { parseArgs } = await import("node:util");
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { worker: { type: "string" } },
  });
  action ??= positionals[0];
  const [{ runAction }, { emitResult }] = await Promise.all([
    import("./actions.mjs"),
    import("./result.mjs"),
  ]);
  const result = await runAction(action, values);
  emitResult(action, result.status, result);
} catch (error) {
  try {
    const { emitFailure } = await import("./result.mjs");
    emitFailure(action, error);
  } catch {
    process.stdout.write(
      "VULTR_RESULT " +
        JSON.stringify({
          schemaVersion: 1,
          plugin: "vultr.sandbox",
          action,
          status: "failed",
          code: "startup_failed",
          message: "Plugin startup failed; reinstall the complete package.",
        }) +
        "\n",
    );
  }
  process.exitCode = 1;
}
