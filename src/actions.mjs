import path from "node:path";
import { ACTIONS } from "./constants.mjs";
import { loadConfig, readPrivate } from "./config.mjs";
import { parsePluginContext, resolveGitContext } from "./context.mjs";
import { Store } from "./state.mjs";
import { openPluginPane, focusPluginPane } from "./herdr.mjs";
import {
  newWorker,
  selectWorker,
  workersInScope,
  workerInfo,
} from "./mappings.mjs";
import { requestWorker, hasLiveOwner } from "./control.mjs";
import { inspectConfiguration } from "./onboarding.mjs";
import { Cloud } from "./provider.mjs";
import { Lifecycle } from "./lifecycle.mjs";
import { PluginError } from "./result.mjs";
export async function runAction(action, { worker } = {}, options = {}) {
  if (!ACTIONS.includes(action))
    throw new PluginError("unknown_action", "Unknown plugin action.");
  if (action === "new-worker" && worker !== undefined)
    throw new PluginError(
      "invalid_action_options",
      "New worker cannot select an existing worker. Use Start or Reconnect with --worker to retry it.",
    );
  const env = options.env ?? process.env,
    context =
      options.context ?? parsePluginContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  const pane = context.focused_pane_id ?? env.HERDR_PANE_ID;
  if (!pane)
    throw new PluginError(
      "caller_required",
      "Herdr must supply an explicit source pane.",
    );
  context.focused_pane_id = pane;
  const store = options.store ?? new Store(env.HERDR_PLUGIN_STATE_DIR);
  if (action === "list")
    return {
      status: "observed",
      workers: workersInScope(store, context, env).map(workerInfo),
    };
  if (action === "check-config")
    return {
      status: "observed",
      ...(await inspectConfiguration(env.HERDR_PLUGIN_CONFIG_DIR, {
        api: options.api,
      })),
    };
  const open = options.openPane ?? openPluginPane;
  const openUI = (entrypoint, id = "") => {
    const opened = open(entrypoint, context, {
      placement: "split",
      targetPaneId: pane,
      cwd: context.focused_pane_cwd ?? context.workspace_cwd,
      focus: false,
      processEnv: env,
      env: {
        HERDR_AGENT: "",
        VULTR_ACTION: entrypoint === "onboarding" ? "connect-vultr" : action,
        VULTR_WORKER: id,
        VULTR_SOURCE_CONTEXT: JSON.stringify(context),
      },
    });
    let paneId;
    try {
      paneId = JSON.parse(opened.stdout).result.plugin_pane.pane.pane_id;
    } catch {
      /* Applied outcome needs inspection, never automatic replay. */
    }
    if (typeof paneId !== "string" || !paneId)
      throw new PluginError(
        "pane_open_unknown",
        "Herdr did not return the created pane ID. Inspect its panes before retrying.",
      );
    return { status: "opened", workerId: id || null, paneId };
  };
  if (action === "connect-vultr") return openUI("onboarding");
  let record =
    action === "new-worker" ? null : selectWorker(store, context, env, worker);
  if (action === "new-worker" || (action === "start-agent" && !record)) {
    const git = resolveGitContext(context);
    const existing =
      action === "new-worker"
        ? []
        : workersInScope(store, context, env).filter(
            (r) =>
              r.phase !== "replaced" &&
              (r.localRoot === git.root ||
                r.sourcePaneId === pane ||
                r.workerPane?.paneId === pane),
          );
    if (existing.length)
      return {
        status: "selection_required",
        workers: existing.map(workerInfo),
      };
    let config;
    try {
      config = (options.loadConfig ?? loadConfig)(env);
    } catch (error) {
      if (
        error.code === "ENOENT" &&
        env.HERDR_PLUGIN_CONFIG_DIR &&
        path.isAbsolute(env.HERDR_PLUGIN_CONFIG_DIR) &&
        error.path === path.join(env.HERDR_PLUGIN_CONFIG_DIR, "config.json")
      )
        return openUI("onboarding");
      throw error;
    }
    record = await newWorker(store, git, context, config, env);
  }
  if (["info", "status"].includes(action)) {
    if (!record)
      return {
        status: "selection_required",
        workers: workersInScope(store, context, env).map(workerInfo),
      };
    if (action === "info") return { status: "observed", ...workerInfo(record) };
    const life =
      options.life ??
      new Lifecycle(
        store,
        options.api ?? new Cloud(readPrivate(record.config.tokenFile)),
        null,
      );
    return {
      status: "observed",
      ...workerInfo(record),
      provider: await life.status(record.id),
    };
  }
  if (record) {
    worker = record.id;
    const owner = await (options.requestWorker ?? requestWorker)(
      store,
      worker,
      action,
    );
    if (owner || hasLiveOwner(store, worker)) {
      const result = owner ?? {
        status: "busy",
        paneId: store.get(worker).workerPane?.paneId,
      };
      if (result.paneId)
        (options.focusPane ?? focusPluginPane)(result.paneId, env);
      return {
        status: result.status,
        workerId: worker,
        paneId: result.paneId ?? null,
        ...(result.requestId ? { requestId: result.requestId } : {}),
      };
    }
  }
  return openUI("worker", worker);
}
