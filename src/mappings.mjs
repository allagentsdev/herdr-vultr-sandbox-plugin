import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { namespace } from "./state.mjs";
import { resolveGitContext } from "./context.mjs";
import { resolveAdapter, adapterCommands, recordAdapter } from "./adapters.mjs";
import { PluginError } from "./result.mjs";
const fail = (code, message) => {
  throw new PluginError(code, message);
};
function inside(root, file) {
  const rel = path.relative(root, path.resolve(file));
  return (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
}
function rebaseAdapter(snapshot, previousWorkerId, workerId) {
  return JSON.parse(
    JSON.stringify(snapshot)
      .replaceAll(
        "/var/lib/herdr/workers/" + previousWorkerId,
        "/var/lib/herdr/workers/" + workerId,
      )
      .replaceAll(
        "/srv/herdr/workers/" + previousWorkerId,
        "/srv/herdr/workers/" + workerId,
      ),
  );
}
export async function newWorker(
  store,
  git,
  context,
  config,
  env = process.env,
  { agentSnapshot, previousWorkerId } = {},
) {
  for (const file of [
    store.directory,
    config.tokenFile,
    config.sshPrivateKey,
    env.HERDR_PLUGIN_CONFIG_DIR,
  ])
    if (
      file &&
      (inside(git.root, file) ||
        (fs.existsSync(file) && inside(git.root, fs.realpathSync(file))))
    )
      fail(
        "private_state_required",
        "Keep state, config and credentials outside the uploaded worktree.",
      );
  const id = randomUUID(),
    stat = fs.statSync(git.root),
    adapter = agentSnapshot
      ? rebaseAdapter(agentSnapshot, previousWorkerId, id)
      : resolveAdapter(config, { workerId: id });
  return store.create({
    id,
    namespace: namespace(env),
    localRoot: git.root,
    localCwd: git.cwd,
    sourcePaneId: git.sourcePaneId,
    workspaceId: context.workspace_id ?? env.HERDR_WORKSPACE_ID,
    rootIdentity: { dev: stat.dev, ino: stat.ino },
    phase: "provisional",
    vm: null,
    snapshot: null,
    pending: null,
    agentAdapter: structuredClone(adapter),
    config: { ...structuredClone(config), adapter: adapterCommands(adapter) },
  });
}
export function workersInScope(
  store,
  context = {},
  env = process.env,
  { includeForgotten = false } = {},
) {
  return store
    .list()
    .filter(
      (r) =>
        r.namespace === namespace(env) &&
        (includeForgotten || r.phase !== "forgotten") &&
        (!context.workspace_id || r.workspaceId === context.workspace_id),
    );
}
export function selectWorker(store, context = {}, env = process.env, explicit) {
  if (explicit) {
    const r = store.get(explicit);
    if (r.namespace !== namespace(env))
      fail("worker_scope", "Worker belongs to another Herdr server/session.");
    return r;
  }
  const pane = context.focused_pane_id ?? env.HERDR_PANE_ID,
    records = workersInScope(store, context, env);
  const direct = records.filter(
    (r) => r.workerPane?.paneId === pane || r.sourcePaneId === pane,
  );
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return null;
  let root;
  try {
    root = resolveGitContext(context).root;
  } catch {
    return null;
  }
  const candidates = records.filter((r) => r.localRoot === root);
  return candidates.length === 1 ? candidates[0] : null;
}
export function workerInfo(r) {
  let rootState = "missing";
  try {
    const s = fs.lstatSync(r.localRoot);
    rootState = s.isSymbolicLink()
      ? "symlink"
      : r.rootIdentity &&
          s.dev === r.rootIdentity.dev &&
          s.ino === r.rootIdentity.ino
        ? "unchanged"
        : "replaced-or-moved";
  } catch {
    // Missing roots remain observable without altering cloud resources.
  }
  let a;
  try {
    a = recordAdapter(r);
  } catch {
    a = {
      kind: r.config.agentKind ?? "custom-command",
      conformance: "pending-live",
    };
  }
  return {
    workerId: r.id,
    phase: r.phase,
    workspaceId: r.workspaceId ?? null,
    sourcePaneId: r.sourcePaneId ?? null,
    paneId: r.workerPane?.paneId ?? null,
    localRoot: r.localRoot,
    localCwd: r.localCwd ?? r.localRoot,
    localRootState: rootState,
    serverId: r.vm?.serverId ?? null,
    previousServerId: r.previousVm?.serverId ?? null,
    snapshotId: r.snapshot?.imageId ?? null,
    previousSnapshotId: r.snapshot?.previousImageId ?? null,
    agentKind: a.kind,
    expectedVersion: a.version ?? null,
    installedVersion: r.agentRuntime?.installedVersion ?? null,
    agentConformance: a.conformance,
    capabilities: a.capabilities ?? {},
    transport: r.transport ?? { state: "not-observed" },
    lastRejectedOperation: r.lastRejectedOperation ?? null,
    controlRequests: r.controlRequests ?? [],
    pendingOperation: r.pending
      ? {
          kind: r.pending.kind,
          operation: r.pending.operation ?? null,
          attempted: r.pending.attempted ?? false,
          acknowledged: r.pending.acknowledged ?? false,
          started: r.pending.started ?? null,
        }
      : null,
    predecessorId: r.predecessorId ?? null,
    successorId: r.successorId ?? null,
  };
}
function deletionTarget(r, confirmation) {
  const id = r.vm?.serverId ?? r.previousVm?.serverId;
  if (r.pending && r.pending.kind !== "delete")
    fail(
      "operation_pending",
      "Reconcile the pending resource operation before replacing or forgetting its mapping.",
    );
  if (id) {
    if (confirmation !== `DELETE ${id}`)
      fail("approval_required", "Exact server deletion approval is required.");
  } else if (confirmation !== `FORGET ${r.id}`)
    fail("approval_required", "Exact unallocated worker approval is required.");
}
export async function replaceWorker(
  store,
  id,
  confirmation,
  { life, env = process.env } = {},
) {
  let r = store.get(id);
  deletionTarget(r, confirmation);
  if (r.successorId) return store.get(r.successorId);
  if (r.vm) await life.deleteServer(id, confirmation);
  return store.withLock(id, async () => {
    r = store.get(id);
    if (r.successorId) return store.get(r.successorId);
    if (r.vm) fail("deletion_uncertain", "The server is still allocated.");
    let next;
    if (r.replacementId && fs.existsSync(store.file(r.replacementId)))
      next = store.get(r.replacementId);
    else {
      next = await newWorker(
        store,
        {
          root: r.localRoot,
          cwd: r.localCwd ?? r.localRoot,
          sourcePaneId: r.sourcePaneId,
        },
        { workspace_id: r.workspaceId },
        r.config,
        env,
        { agentSnapshot: recordAdapter(r), previousWorkerId: id },
      );
      await store.update(id, (v) => ({ ...v, replacementId: next.id }));
      next = await store.update(next.id, (v) => ({
        ...v,
        namespace: r.namespace,
        predecessorId: id,
      }));
    }
    await store.update(id, (v) => ({
      ...v,
      phase: "replaced",
      successorId: next.id,
      sourcePaneId: null,
    }));
    return next;
  });
}
export async function forgetWorker(store, id, confirmation, { life } = {}) {
  let r = store.get(id);
  deletionTarget(r, confirmation);
  if (r.vm) await life.deleteServer(id, confirmation);
  return store.withLock(id, async () => {
    r = store.get(id);
    if (r.vm || r.pending)
      fail(
        "deletion_uncertain",
        "Provider deletion is not confirmed; mapping retained.",
      );
    return store.update(id, (v) => ({
      ...v,
      phase: "forgotten",
      sourcePaneId: null,
      workerPane: null,
      forgottenAt: new Date().toISOString(),
    }));
  });
}
