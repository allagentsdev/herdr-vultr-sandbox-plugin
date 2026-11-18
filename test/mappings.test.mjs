import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, namespace } from "../src/state.mjs";
import {
  selectWorker,
  workerInfo,
  newWorker,
  replaceWorker,
  forgetWorker,
} from "../src/mappings.mjs";
import { temporary, repository, write } from "./helpers.mjs";
async function fixture(t) {
  const store = new Store(temporary(t)),
    root = repository(t),
    env = { HERDR_SOCKET_PATH: "/test/socket" },
    id = randomUUID();
  const st = fs.statSync(root);
  await store.create({
    id,
    namespace: namespace(env),
    localRoot: root,
    localCwd: root,
    sourcePaneId: "w1:p1",
    workspaceId: "w1",
    rootIdentity: { dev: st.dev, ino: st.ino },
    config: {
      adapter: {
        install: "",
        launch: "agent",
        resume: "agent resume",
        authCheck: "check",
      },
      tokenFile: "/private/token",
      sshPrivateKey: "/private/key",
    },
    vm: { serverId: 42 },
    snapshot: { imageId: 8 },
    phase: "ready",
  });
  return { store, root, env, id };
}
test("pane mappings select the same worker and diagnostics never expose credential paths or hook contents", async (t) => {
  const f = await fixture(t);
  const r = selectWorker(f.store, { focused_pane_id: "w1:p1" }, f.env);
  assert.equal(r.id, f.id);
  const info = workerInfo(r);
  assert.equal(info.workerId, f.id);
  assert.equal(info.serverId, 42);
  assert.ok(!JSON.stringify(info).includes("/private/token"));
  assert.ok(!JSON.stringify(info).includes("/private/key"));
  assert.ok(!JSON.stringify(info).includes("agent resume"));
});
test("a replacement retains history and cannot create a successor before destructive confirmation/deletion", async (t) => {
  const f = await fixture(t);
  let deleted = false;
  const life = {
    async deleteServer(id, confirmation) {
      assert.equal(id, f.id);
      assert.equal(confirmation, "DELETE 42");
      deleted = true;
      await f.store.update(id, (r) => ({
        ...r,
        previousVm: r.vm,
        vm: null,
        phase: "deleted",
      }));
    },
  };
  await assert.rejects(replaceWorker(f.store, f.id, "DELETE 99", { life }));
  assert.equal(deleted, false);
  const next = await replaceWorker(f.store, f.id, "DELETE 42", { life });
  assert.notEqual(next.id, f.id);
  assert.equal(next.predecessorId, f.id);
  assert.equal(next.vm, null);
  assert.equal(next.uploadApproval, undefined);
  assert.equal(f.store.get(f.id).successorId, next.id);
  assert.equal(f.store.get(f.id).snapshot.imageId, 8);
});
test("forget removes pane mappings only after confirmed deletion and keeps snapshot recovery metadata", async (t) => {
  const f = await fixture(t);
  const life = {
    async deleteServer() {
      throw Object.assign(Error("pending"), { code: "outcome_unknown" });
    },
  };
  await assert.rejects(forgetWorker(f.store, f.id, "DELETE 42", { life }), {
    code: "outcome_unknown",
  });
  assert.equal(f.store.get(f.id).sourcePaneId, "w1:p1");
  life.deleteServer = async () =>
    f.store.update(f.id, (r) => ({ ...r, vm: null, phase: "deleted" }));
  await forgetWorker(f.store, f.id, "DELETE 42", { life });
  assert.equal(f.store.get(f.id).sourcePaneId, null);
  assert.equal(f.store.get(f.id).phase, "forgotten");
  assert.equal(f.store.get(f.id).snapshot.imageId, 8);
});
test("fresh worker freezes its adapter and source identity without storing host credential bytes", async (t) => {
  const f = await fixture(t);
  write(f.root, "source", "content");
  const c = {
    agentKind: "codex",
    allowCandidateAgents: true,
    tokenFile: path.join(temporary(t), "token"),
    sshPrivateKey: path.join(temporary(t), "key"),
    adapter: {},
    maxFiles: 100,
  };
  const record = await newWorker(
    f.store,
    { root: f.root, cwd: f.root, sourcePaneId: "w1:p1" },
    { workspace_id: "w1" },
    c,
    f.env,
  );
  assert.equal(record.guestBackend, "herdr");
  assert.equal(record.agentAdapter.kind, "codex");
  assert.equal(record.agentAdapter.conformance, "pending-live");
  assert.equal(record.vm, null);
  assert.equal(record.config.adapter.launch, record.agentAdapter.launch);
});

test("unmapped lifecycle callers resolve their own canonical Git checkout, not the workspace repository", async (t) => {
  const { selectWorker } = await import("../src/mappings.mjs");
  const { namespace } = await import("../src/state.mjs");
  const store = new Store(temporary(t)),
    a = repository(t),
    b = repository(t),
    id = randomUUID(),
    env = { HERDR_PANE_ID: "w1:p2" };
  await store.create({
    id,
    namespace: namespace(env),
    sourcePaneId: "w1:p1",
    localRoot: a,
    config: {},
  });
  assert.equal(
    selectWorker(
      store,
      { focused_pane_id: "w1:p2", focused_pane_cwd: b, workspace_cwd: a },
      env,
    ),
    null,
  );
  fs.mkdirSync(path.join(a, "subdirectory"));
  assert.equal(
    selectWorker(
      store,
      {
        focused_pane_id: "w1:p2",
        focused_pane_cwd: path.join(a, "subdirectory"),
        workspace_cwd: b,
      },
      env,
    ).id,
    id,
  );
  assert.equal(selectWorker(store, { focused_pane_id: "w1:p2" }, env), null);
  assert.equal(
    selectWorker(
      store,
      {
        focused_pane_id: "w1:p2",
        focused_pane_cwd: b,
        worktree: { checkout_path: a },
      },
      env,
    ),
    null,
  );
});
