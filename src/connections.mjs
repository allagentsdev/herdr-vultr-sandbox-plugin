import { PluginError } from "./result.mjs";
export class Connections {
  constructor(store, life, remote, { pin, clientKey } = {}) {
    this.store = store;
    this.life = life;
    this.remote = remote;
    this.pin = pin;
    this.clientKey = clientKey;
  }
  async prepare(id, mode) {
    return this.store.withLock(id, async () => {
      let r = this.store.get(id);
      const recovering = r.pending?.kind === "create";
      if (recovering || (mode === "resume" && !r.vm)) {
        if (!recovering && !r.snapshot)
          throw new PluginError(
            "snapshot_missing",
            "No recoverable snapshot is recorded.",
          );
        const key =
          r.vm || r.pending?.attempted ? undefined : await this.clientKey?.(r);
        r = await this.life.createLocked(id, key);
      } else if (mode === "resume")
        r = await this.life.powerLocked(id, "poweron");
      const server = await this.life.owned(r);
      if (server?.powerState !== "running")
        throw new PluginError(
          "server_not_running",
          "Use Resume to start or restore this worker.",
        );
      if (r.pending || (mode !== "resume" && r.hibernate))
        throw new PluginError(
          "operation_pending",
          "Finish the pending lifecycle operation or explicitly Resume this worker.",
        );
      if (!r.vm.hostKey) r = await this.pin(r, server);
      if (mode === "resume") await this.remote.waitReady?.(r);
      if (!r.vm.initialized) {
        const runtime = await this.remote.setup(r);
        r = await this.store.update(id, (v) => ({
          ...v,
          vm: { ...v.vm, initialized: true },
          agentRuntime: { installedVersion: runtime?.installedVersion ?? null },
          phase: "login-required",
        }));
      }
      if (r.phase === "restore-verification") await this.remote.verifyResume(r);
      else if (mode === "resume") await this.remote.activate(r);
      else await this.remote.auth(r);
      r = await this.store.update(id, (v) => ({
        ...v,
        phase: "ready",
        hibernate: null,
      }));
      await this.remote.ensureWorker(r);
      if (mode === "restart-agent") await this.remote.restartAgent(r);
      return r;
    });
  }
}
