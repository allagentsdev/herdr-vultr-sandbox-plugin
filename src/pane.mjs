import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { ACTIONS } from "./constants.mjs";
import { Store, namespace } from "./state.mjs";
import { readPrivate } from "./config.mjs";
import { captureSnapshot, readSnapshot } from "./manifest.mjs";
import { Cloud } from "./provider.mjs";
import { SSH, remotePaths, clientPublicKey } from "./ssh.mjs";
import { Remote } from "./remote.mjs";
import { Lifecycle } from "./lifecycle.mjs";
import { Connections } from "./connections.mjs";
import { serveWorker } from "./control.mjs";
import { currentPane, reportSession } from "./herdr.mjs";
import { recordAdapter } from "./adapters.mjs";
import { guestBackend } from "./guest-herdr.mjs";
import { workerInfo, replaceWorker, forgetWorker } from "./mappings.mjs";
import { saveConfiguration, inspectConfiguration } from "./onboarding.mjs";
import { runSync } from "./process.mjs";
import { preparePatch, applyReviewedPatch, reviewText } from "./patch.mjs";
import { safeText, emitFailure, PluginError } from "./result.mjs";
const show = (s) => process.stdout.write(safeText(s) + "\n");
async function ask(prompt) {
  if (!process.stdin.isTTY)
    throw new PluginError(
      "interactive_required",
      "Use the Herdr operation pane for explicit approval.",
    );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(safeText(prompt));
  } finally {
    rl.close();
  }
}
async function approveUpload(store, id) {
  return store.withLock(id, async () => {
    let r = store.get(id);
    if (r.uploadApproval) return readSnapshot(r.baseline);
    const snapshot = captureSnapshot(
      r.localRoot,
      r.config,
      path.join(store.artifacts(id), "baseline-" + randomUUID()),
    );
    r = await store.update(id, (v) => ({
      ...v,
      baseline: snapshot.directory,
      baselineDigest: snapshot.digest,
      checkpoint: snapshot.directory,
      checkpointDigest: snapshot.digest,
      phase: "upload-review",
    }));
    show(
      `Worker: ${id}\nDestination: ${remotePaths(r).source}\nServer: ${r.config.plan} in ${r.config.region}; image ${r.config.osId}\nManifest: ${snapshot.directory}/manifest.json\nSHA256: ${snapshot.digest}\n${snapshot.files.length} files, ${snapshot.totalBytes} bytes. ${snapshot.excluded.length} excluded paths.\nComplete eligible manifest (path, size, mode, SHA256):\n${snapshot.files.map((f) => `${JSON.stringify(f.path)}\t${f.size}\t${f.mode}\t${f.sha256}`).join("\n")}\nReview ordinary source for secrets the filters cannot detect. Server/IPv4 billing starts on allocation; power-off stays billed. Snapshots are billed separately.`,
    );
    if (
      (await ask(
        `Type UPLOAD ${snapshot.digest} to approve these exact bytes and allocate the dedicated server > `,
      )) !== `UPLOAD ${snapshot.digest}`
    )
      throw new PluginError(
        "upload_cancelled",
        "Upload cancelled; no server allocated.",
      );
    if (readSnapshot(r.baseline).digest !== snapshot.digest)
      throw new PluginError("snapshot_corrupt", "Reviewed source changed.");
    await store.update(id, (v) => ({
      ...v,
      uploadApproval: {
        digest: snapshot.digest,
        approvedAt: new Date().toISOString(),
      },
      phase: "upload-approved",
    }));
    return snapshot;
  });
}
async function choose(store) {
  const scope = namespace(),
    context = JSON.parse(process.env.VULTR_SOURCE_CONTEXT ?? "{}");
  const records = store
    .list()
    .filter(
      (r) =>
        r.namespace === scope &&
        (!context.workspace_id || r.workspaceId === context.workspace_id),
    );
  for (const r of records)
    show(
      `${r.id}  ${r.phase}  server=${r.vm?.serverId ?? "none"} snapshot=${r.snapshot?.imageId ?? "none"}  ${r.localRoot}`,
    );
  const id = process.env.VULTR_WORKER || (await ask("Worker UUID > ")),
    r = store.get(id);
  if (r.namespace !== scope)
    throw new PluginError(
      "worker_scope",
      "Worker belongs to another Herdr session/server.",
    );
  return id;
}
async function onboarding() {
  const directory = process.env.HERDR_PLUGIN_CONFIG_DIR;
  show(
    "Use a dedicated Vultr API token and client SSH key. Enter file paths only. Agent authentication happens independently on the remote worker. No compute is allocated by onboarding.",
  );
  if (!fs.existsSync(path.join(directory, "config.json"))) {
    const tokenFile = await ask("Absolute path to 0600 API token file > "),
      sshPrivateKey = await ask(
        "Absolute path to 0600 client SSH private key > ",
      ),
      sshPublicKey = await ask("Absolute path to intended SSH public key > ");
    const agentKind =
      (await ask(
        "Agent: codex, codex-compound, claude-code or opencode [codex] > ",
      )) || "codex";
    const consent = await ask(
      "Vultr adapter live conformance is pending. Type CANDIDATE to enable this candidate > ",
    );
    saveConfiguration(directory, {
      tokenFile,
      sshPrivateKey,
      sshPublicKey,
      agentKind,
      allowCandidateAgents: consent === "CANDIDATE",
    });
  }
  show(JSON.stringify(await inspectConfiguration(directory), null, 2));
  show(
    "Configuration saved. Start agent reviews exact source before allocating a billed server. Existing configuration can be edited in its protected config.json.",
  );
}
function restoreTerminal() {
  if (process.stdin.isTTY) {
    runSync("stty", ["sane"], { stdio: "inherit", check: false });
    process.stdout.write(
      "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h",
    );
  }
}
export async function runWorker({
  store = new Store(),
  id,
  initialAction = process.env.VULTR_ACTION,
  services,
  askInput = ask,
  menuInput,
  display = show,
  env = process.env,
  resolvePane = currentPane,
  registerSession = reportSession,
} = {}) {
  id ??= await choose(store);
  let r = store.get(id),
    paneId = resolvePane(env),
    busy = true,
    queued = null,
    wake = null,
    controlRequestId = null,
    acceptance = null;
  const recordRequest = (requestId, action, status, code = null) =>
    store.update(id, (v) => {
      const requests = v.controlRequests ?? [];
      const previous = requests.find((x) => x.requestId === requestId);
      const record = {
        requestId,
        action,
        status,
        code,
        acceptedAt: previous?.acceptedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return {
        ...v,
        controlRequests: [
          ...requests.filter((x) => x.requestId !== requestId),
          record,
        ].slice(-20),
      };
    });
  const interruptRequests = (requests, code) =>
    (requests ?? []).map((request) =>
      ["queued", "running"].includes(request.status)
        ? {
            ...request,
            status: "interrupted",
            code,
            updatedAt: new Date().toISOString(),
          }
        : request,
    );
  const close = await serveWorker(store, id, async (action) => {
    paneId = resolvePane(env);
    if (action === "ping") return { status: "alive", paneId };
    if (!ACTIONS.includes(action)) return { status: "invalid_request", paneId };
    if (busy || queued || acceptance) return { status: "busy", paneId };
    const requestId = randomUUID();
    acceptance = recordRequest(requestId, action, "queued");
    try {
      await acceptance;
      queued = { action, requestId };
      wake?.();
      return { status: "queued", paneId, requestId };
    } finally {
      acceptance = null;
    }
  });
  let api, ssh, remote, life;
  try {
    await store.update(id, (v) => ({
      ...v,
      workerPane: { paneId, pid: process.pid },
      transport: { state: "dashboard" },
      controlRequests: interruptRequests(
        v.controlRequests,
        "previous_owner_lost",
      ),
    }));
    if (services) ({ api, ssh, remote, life } = services);
    else {
      api = new Cloud(readPrivate(r.config.tokenFile));
      ssh = new SSH(store, r.config);
      remote = new Remote(ssh);
      life = new Lifecycle(store, api, remote);
    }
    const clientKey = async (record = store.get(id)) =>
      clientPublicKey(record.config);
    const pin = async (record = store.get(id), server) => {
      if (record.vm?.hostKey) return record;
      server ??= await life.owned(record);
      display(
        `Server ${record.vm.serverId}. Obtain its ed25519 fingerprint through the authenticated Vultr Console: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`,
      );
      return ssh.pin(
        record,
        server,
        await askInput("Console-verified SHA256 fingerprint > "),
      );
    };
    const connections = new Connections(store, life, remote, {
      pin,
      clientKey,
    });
    const attach = async () => {
      paneId = resolvePane(env);
      await store.update(id, (v) => ({
        ...v,
        workerPane: { paneId, pid: process.pid },
        transport: { state: "attached", sessionMetadata: false },
      }));
      display(
        guestBackend(r) === "herdr"
          ? "Attached to the same native Herdr terminal. Ctrl-b q returns here without stopping it; Ctrl-b Ctrl-b sends literal Ctrl-b. Closing this local pane leaves compute allocated."
          : "Attached to the legacy tmux worker. Ctrl-b d returns here without stopping it. Closing this local pane leaves compute allocated.",
      );
      let exit, metadata;
      const registration = new AbortController();
      try {
        const attachment = remote.attach(r);
        metadata = (async () => {
          const kind = recordAdapter(r).capabilities.herdrDetectionKind;
          for (let attempt = 0; attempt < 20; attempt++) {
            if (registration.signal.aborted) return;
            if (registerSession(id, paneId, kind, env)) {
              await store.update(id, (v) => ({
                ...v,
                transport: { ...v.transport, sessionMetadata: true },
              }));
              return;
            }
            await delay(250, undefined, { signal: registration.signal });
          }
        })().catch((error) => {
          if (error.name !== "AbortError")
            display("Continuation metadata could not be recorded.");
        });
        exit = await attachment;
      } finally {
        registration.abort();
        await metadata;
        restoreTerminal();
      }
      let session;
      try {
        session = remote.inspectSession(r);
      } catch {
        session = { status: "transport-unavailable" };
      }
      await store.update(id, (v) => ({
        ...v,
        ...(session.backend === "herdr" ? { guestHerdr: session } : {}),
        transport: {
          state: session.status,
          exit: exit ?? null,
          remoteSession: session,
          observedAt: new Date().toISOString(),
        },
      }));
      display(
        `Transport returned: ${session.status}. Compute power is not inferred; choose Status for provider confirmation.`,
      );
      if (exit?.code !== 0 || exit?.signal)
        throw new PluginError(
          "transport_failed",
          "SSH attachment ended unsuccessfully; remote process and provider state require observation.",
        );
    };
    const login = async () => {
      let exit;
      try {
        exit = await remote.login(r);
      } finally {
        restoreTerminal();
      }
      if (exit?.code !== 0 || exit?.signal)
        throw new PluginError(
          "login_failed",
          "Remote login process ended unsuccessfully; complete owner login before reconnecting.",
        );
    };
    let action = initialAction;
    while (true) {
      busy = true;
      r = store.get(id);
      let terminalStatus = "completed",
        terminalCode = null;
      if (controlRequestId)
        await recordRequest(controlRequestId, action, "running");
      try {
        switch (action) {
          case "new-worker":
          case "start-agent": {
            if (r.vm?.initialized && r.uploadApproval) {
              r = await connections.prepare(id, "reconnect");
              await attach();
              break;
            }
            await approveUpload(store, id);
            r = store.get(id);
            r = await life.create(
              id,
              r.vm || r.pending?.attempted ? undefined : await clientKey(),
            );
            r = await pin(r);
            await store.withLock(id, async () => {
              r = store.get(id);
              if (!r.vm.initialized) {
                const runtime = await remote.setup(r);
                r = await store.update(id, (v) => ({
                  ...v,
                  vm: { ...v.vm, initialized: true },
                  agentRuntime: {
                    installedVersion: runtime.installedVersion ?? null,
                  },
                  phase: "login-required",
                }));
              }
            });
            display(
              "Source is ready. Complete independent remote agent login. Host authentication and private skills were not copied.",
            );
            await login();
            r = await connections.prepare(id, "reconnect");
            await attach();
            break;
          }
          case "pin-host":
            await pin();
            break;
          case "login":
            r = await pin();
            await login();
            break;
          case "reconnect":
          case "resume":
            display(
              "Confirming provider power and strict pinned SSH readiness for this worker.",
            );
            r = await connections.prepare(id, action);
            await attach();
            break;
          case "restart-agent":
            if (
              (await askInput(
                `Type RESTART ${id} to resume a confirmed exited agent > `,
              )) !== `RESTART ${id}`
            ) {
              terminalStatus = "cancelled";
              terminalCode = "approval_declined";
              break;
            }
            r = await connections.prepare(id, "restart-agent");
            await attach();
            break;
          case "stop":
            await life.power(id, "shutdown");
            display(JSON.stringify(await life.status(id), null, 2));
            break;
          case "status":
            display(JSON.stringify(await life.status(id), null, 2));
            break;
          case "info":
            display(JSON.stringify(workerInfo(r), null, 2));
            break;
          case "recover": {
            if (r.pending?.kind === "create" && r.pending.attempted)
              await life.create(id);
            else if (["shutdown", "poweron"].includes(r.pending?.kind))
              await life.power(id, r.pending.kind);
            else if (r.pending?.kind === "delete") {
              if (r.hibernate?.stage === "release")
                await life.release(id, r.pending.confirmation);
              else await life.deleteServer(id, r.pending.confirmation);
            } else if (r.hibernate)
              display(JSON.stringify(await life.hibernate(id), null, 2));
            display(JSON.stringify(await life.status(id), null, 2));
            break;
          }
          case "hibernate": {
            const result = await life.hibernate(id);
            display(JSON.stringify(result, null, 2));
            display(
              "Snapshot includes remote agent credentials and disk state, no RAM or attached volumes. Releasing destroys this server disk. Snapshots remain billed.",
            );
            await life.release(
              id,
              await askInput(
                `Type ${result.confirmation} to release this exact server > `,
              ),
            );
            display(JSON.stringify(await life.status(id), null, 2));
            break;
          }
          case "delete-server":
          case "forget":
          case "replace": {
            display(
              "Permanent deletion loses unsnapshotted disk data. Recovery snapshots and their billing are retained.",
            );
            const expected =
              r.vm || r.previousVm
                ? `DELETE ${(r.vm ?? r.previousVm).serverId}`
                : `FORGET ${id}`;
            const confirmation = await askInput(
              `Type ${expected} to ${action} this exact worker/server > `,
            );
            if (action === "delete-server")
              await life.deleteServer(id, confirmation);
            else if (action === "forget") {
              await forgetWorker(store, id, confirmation, { life });
              return;
            } else {
              const next = await replaceWorker(store, id, confirmation, {
                life,
                env,
              });
              display(
                `Replacement worker ${next.id} is provisional. Start it by explicit worker ID to review source before allocation.`,
              );
              return;
            }
            display(JSON.stringify(await life.status(id), null, 2));
            break;
          }
          case "apply-changes": {
            const candidate = await preparePatch(store, id, remote);
            if (candidate.status === "no_change") {
              display("No changes.");
              break;
            }
            display(reviewText(candidate));
            if (
              (await askInput(
                `Type APPLY ${candidate.digest} to apply this reviewed patch > `,
              )) === `APPLY ${candidate.digest}`
            )
              display(
                JSON.stringify(
                  await applyReviewedPatch(
                    store,
                    id,
                    candidate.artifact,
                    candidate.digest,
                  ),
                ),
              );
            else {
              terminalStatus = "cancelled";
              terminalCode = "approval_declined";
              display("Review retained. Local files unchanged.");
            }
            break;
          }
          case undefined:
          case "":
            break;
          default:
            throw new PluginError(
              "unknown_action",
              "Unknown worker operation.",
            );
        }
      } catch (error) {
        terminalStatus = ["upload_cancelled", "approval_required"].includes(
          error.code,
        )
          ? "cancelled"
          : "failed";
        terminalCode =
          error instanceof PluginError ? error.code : "unexpected_error";
        display(
          error instanceof PluginError
            ? error.message
            : "Operation failed. Retained worker state is available for recovery.",
        );
      } finally {
        if (controlRequestId)
          await recordRequest(
            controlRequestId,
            action,
            terminalStatus,
            terminalCode,
          );
        controlRequestId = null;
      }
      busy = false;
      display(
        `Worker ${id} — reconnect | resume | login | status | info | recover | apply-changes | hibernate | stop | restart-agent | replace | forget | delete-server | q`,
      );
      if (queued) {
        ({ action, requestId: controlRequestId } = queued);
        queued = null;
        continue;
      }
      if (menuInput) {
        action = await menuInput();
        if (action === "q") return;
        continue;
      }
      const abort = new AbortController();
      wake = () => abort.abort();
      try {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          action = await rl.question("Vultr worker > ", {
            signal: abort.signal,
          });
        } finally {
          rl.close();
        }
      } catch (error) {
        if (error.name !== "AbortError") throw error;
        ({ action, requestId: controlRequestId } = queued);
        queued = null;
      } finally {
        wake = null;
      }
      if (action === "q") return;
    }
  } finally {
    busy = true;
    await acceptance?.catch(() => {});
    await close();
    await store.update(id, (v) =>
      v.workerPane?.pid === process.pid
        ? {
            ...v,
            workerPane: null,
            controlRequests: interruptRequests(
              v.controlRequests,
              "owner_closed",
            ),
          }
        : v,
    );
  }
}
async function main() {
  if (process.env.VULTR_ACTION === "connect-vultr") {
    await onboarding();
    return;
  }
  await runWorker();
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    await main();
  } catch (error) {
    emitFailure(process.env.VULTR_ACTION, error);
    process.exitCode = 1;
  }
}
