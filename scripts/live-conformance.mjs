import { parseArgs } from "node:util";
import { Store } from "../src/state.mjs";
import { readPrivate } from "../src/config.mjs";
import { Cloud, resourceId } from "../src/provider.mjs";
import { Lifecycle } from "../src/lifecycle.mjs";
import { SSH, remotePaths } from "../src/ssh.mjs";
import { Remote } from "../src/remote.mjs";
import { guestBackend } from "../src/guest-herdr.mjs";
import { shellQuote as q } from "../src/process.mjs";
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
  ssh.exec(r, `test -d ${q(source)} && test -s ${q(state + "/identity.json")}`);
  const session = new Remote(ssh).inspectSession(r);
  if (session.status !== "detached")
    throw Error("Remote agent is not observed running; nothing was started.");
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
      guestBackend: guestBackend(r),
      remoteSession: {
        status: session.status,
        workspaceId: session.workspaceId ?? null,
        paneId: session.paneId ?? null,
        terminalId: session.terminalId ?? null,
      },
    }),
  );
} catch (e) {
  emitFailure("live-conformance", e);
  process.exitCode = 1;
}
