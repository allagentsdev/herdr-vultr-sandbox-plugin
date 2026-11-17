import { parseArgs } from "node:util";
import { Store } from "../src/state.mjs";
import { readPrivate } from "../src/config.mjs";
import { Cloud, resourceId } from "../src/provider.mjs";
import { Lifecycle } from "../src/lifecycle.mjs";
import { SSH, remotePaths } from "../src/ssh.mjs";
import { emitFailure } from "../src/result.mjs";
const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    server: { type: "string" },
    snapshot: { type: "string" },
    "dedicated-account": { type: "boolean" },
    "allow-live-conformance": { type: "boolean" },
  },
});
try {
  if (
    !values["allow-live-conformance"] ||
    !values["dedicated-account"] ||
    !values.worker ||
    !values.server
  )
    throw Error(
      "Explicit live opt-in, dedicated-account acknowledgement and worker/server IDs required.",
    );
  const store = new Store(),
    r = store.get(values.worker);
  if (r.vm?.serverId !== resourceId(values.server))
    throw Error(
      "Explicit server does not match recorded worker; no request sent.",
    );
  if (values.snapshot && r.snapshot?.imageId !== resourceId(values.snapshot))
    throw Error("Explicit snapshot does not match record.");
  const api = new Cloud(readPrivate(r.config.tokenFile)),
    life = new Lifecycle(store, api);
  const status = await life.status(r.id);
  if (status.providerStatus !== "running")
    throw Error("Server is not running. This script will not start it.");
  const ssh = new SSH(store, r.config),
    { source, state } = remotePaths(r);
  // Remote output is intentionally discarded; it could include agent credentials.
  ssh.exec(
    r,
    `test -d '${source}' && test -s '${state}/identity.json' && tmux has-session -t 'herdr-${r.id}'`,
  );
  if (values.snapshot) {
    const image = await api.getImage(resourceId(values.snapshot));
    life.usable(image, r);
  }
  console.log(
    JSON.stringify({
      status: "observed",
      workerId: r.id,
      serverId: r.vm.serverId,
      snapshotId: r.snapshot?.imageId ?? null,
      providerStatus: status.providerStatus,
      sshPinned: true,
      sourcePresent: true,
      tmuxPresent: true,
    }),
  );
} catch (e) {
  emitFailure("live-conformance", e);
  process.exitCode = 1;
}
