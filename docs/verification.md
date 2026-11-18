# Reproducing validation

Use a Linux host with Node 22+, Git, OpenSSH, tmux and an actual official Herdr
0.9.5 binary. Keep all generated output and logs in a private directory outside
Git. Run from this checkout:

```sh
npm ci
npm run check
VULTR_HERDR_TEST_BIN=/absolute/official/herdr npm run test:herdr
VULTR_HERDR_TEST_BIN=/absolute/official/herdr npm run test:guest-herdr
npm run test:package
```

`check` runs formatting, ESLint, manifest validation and Node tests. The tests
exercise fake provider contracts, real Git/source receivers, isolated tmux,
private socket ownership, exact approvals and recovery. No Vultr credential is
read and no Vultr resource is created by them. Noninteractive SSH deadlines, definitive rejection retry, queryable queued
failures/cancellations, exact opened pane IDs and interrupted-owner receipts
have discriminating regressions. Release re-fetch checks snapshot-description
tampering without deleting the instance; real tmux observations use bounded
state polling. The reference source/patch
characterization passed before adaptation; the rewritten Vultr provider and
lifecycle tests failed against the old implementation before the new methods
were written.

`test:herdr` uses a named disposable server with isolated XDG config/state/cache
and its own explicit socket. It never routes through the active-session shim.
It links the plugin only into that isolated configuration, checks real foreground
hints, `agent prompt --wait`, session metadata, hint revocation, installed
onboarding, persistent dashboard and IPC reconnect, then stops its owned server.
The agent UI and SSH/provider endpoint are synthetic. The current host active
session and global installation are not test targets.

`test:package` packs to a temporary directory outside the repo, extracts the
package, runs production `npm install --omit=dev --ignore-scripts` (npm archives omit package-lock.json), then invokes the
absolute action entrypoint from an unrelated cwd and an isolated empty state.
The runtime has zero production dependencies. It rejects unexpected source
artifacts and checks the clean configuration example is packaged. No package
archive or node_modules belongs in Git.

The optional public Compound check installs only public assets into a disposable
home and authenticates no account:

```sh
VULTR_CODEX_TEST_BIN=/absolute/native/codex-0.169.0 npm run test:codex-bootstrap
```

No host launcher, private profile or host account directory is used. This proves
public plugin installation and modern profile parsing locally, not remote login.

## Opt-in live observations

The read-only entrypoint requires separate explicit owner authorization. An
existing worker can then be observed without resource mutation:

```sh
npm run test:live -- --allow-live-conformance --dedicated-account \
  --worker EXACT_WORKER_UUID --server EXACT_VULTR_INSTANCE_ID
```

Supply `--snapshot EXACT_SNAPSHOT_ID` only to inspect the worker's already saved
snapshot. The script checks exact durable IDs before reading the token, observes
provider ownership/power, performs strict pinned SSH source/identity checks and
observes the selected native Herdr or legacy tmux backend,
and reports only observed session status and workspace/pane/terminal IDs. Raw
source-probe output and free-form agent metadata (including tokens, state labels,
session values, titles and working directories) are omitted. It never starts,
halts, rebuilds, creates or deletes resources. Successful output is a limited observation, not full lifecycle or
authenticated-agent conformance. The broader trial checklist is in the capability
matrix. Deletion always remains an exact-target user approval in the dashboard.

Private logs for this implementation are retained outside Git. The generated host-key cloud-config also validated with zero errors against the
official Canonical cloud-init 25.3 schema. Temporary private key data was deleted
and never logged. The PR records
check counts, official binary version/hash, production package smoke and the
actual independent review receipt. A later owner-authorized live trial verified
the merged legacy worker's source/bootstrap, independent Codex authentication,
patch application, allocated resume and conversation/checkpoint persistence.
Separate actual guest Herdr/Codex and helper process proofs do not establish the
complete fresh-worker native Herdr lifecycle or snapshot restore. The exact
reviewed recovery image completed, and normal exact-target release removed the
disposable instance while retaining that authenticated image. Provider inventory
confirmed no residual instance, block or reserved IP. Snapshot restore remains
untested.

## Live provider Stop gate

In the authorized 2026-11-18 trial of merged commit
`371d4905c422f481847f9f661f99769062ea7b98`, normal Stop quiesced and checkpointed
the worker and acknowledged guest shutdown. SSH became unavailable, but fresh
provider reads still reported running. Provider stopped power required a
separately authorized exact-target `/halt`, which
[Vultr documents as provider Stop](https://docs.vultr.com/products/compute/instances/cloud-compute/management/stop-instance).
Those reconciliation receipts are distinct from plugin success. Snapshot locking
can subsequently produce `power_status=stopped` with `server_status=locked`;
complete/usable image and fresh stopped/unlocked observations are separate gates.

The local correction replaces guest-only shutdown with the documented exact
provider Stop after graceful application/agent quiesce, service hooks and a
flushed durable source checkpoint. Hibernate also cleans and flushes cloud-init's
clone cache first. No guest OS shutdown behavior is inferred from the provider
operation. A new Stop receipt records `providerOperation: "halt"` and the exact
instance; intent and attempt persist before the bodyless POST, acknowledgement
persists separately, and fresh provider OFF is required before snapshot creation.
Historical guest-shutdown receipts cannot authorize a new provider mutation.

The discriminating regression first failed against the unchanged lifecycle:
with guest acknowledgement independent of provider power, Stop observed
`running` instead of `off`. The corrected fixtures change provider power only
through the exact API operation. Focused local tests prove Stop/Hibernate order,
durable checkpoint and intent before submission, separate acknowledgement/OFF,
unknown request and failed acknowledgement/observation without replay, explicit
retry after definitive rejection, ownership/target/block gates, OFF idempotency,
Start protection and stopped-but-locked remaining transitioning. Existing snapshot
identity/checkpoint/release and restore-readiness proofs remain intact.

The failed allocated Resume regression runs the actual activation command through
an owned local shell: a configured restart hook launches a synthetic writer and
then fails. Its heartbeat advances after the failure; normal Stop waits for that
writer to exit before capturing fresh source. Both stopped and already-running
allocated Resume retire the old release authority, including failed Start or
activation, while retaining the previous snapshot. A separate upgrade proof runs
the previous lifecycle through the failing hook, reuses its actual stored record
with the corrected lifecycle, and verifies fresh Stop retires the obsolete release. Intentional Recover of an
unchanged quiescent Hibernate stage still skips repeated hooks and mutations.

Real Store tests observe file fsync, rename, parent-directory fsync, then the
synthetic provider request in that order. Injected file/directory sync failures
prevent submission, close descriptors and remove owned temporary files; a
post-rename directory-sync failure retains an attempted receipt and prevents
replay. This checks the actual persistence protocol and failure gating. No host
power loss, hardware durability experiment or live provider operation is implied.

These are local synthetic boundary proofs. The correction still needs an
authorized live trial. A retained legacy image restore can verify its own
provider/source/auth behavior but cannot establish native conformance. A separate
fresh native logical worker needs independent source approval, home, login and
trust; native snapshot restore remains untested. Private raw live receipts,
exact IDs and cleanup decisions remain outside the repository.

`test:guest-herdr` also requires Python 3 for its controlling-PTY driver. It starts
only owned isolated stock Herdr servers through the
deployable guest helper. It checks a full worker UUID with an explicit short
socket, real workspace/pane/terminal/process IDs, native prompt/wait, repeated
reconnect without relaunch, real PTY manual detach and live reconnect, actual
child exit returning the real worker dashboard while retaining its native terminal,
refusal to restart a live process, explicit dead restart, and restoration with
automatic agent launch disabled. Its agent is the
repository's explicitly synthetic transport fixture with a detection hint; no
host authentication is used. Raw sanitized helper receipts and server logs remain
in the printed temporary proof directory. Fresh-worker marker and unmarked
legacy behavior are separately checked by mappings/remote/SSH tests.

The native recovery proof additionally consumes failed Resume authorization before
setup, rejects stale authorization on ordinary Reconnect, and checks an actual
synthetic writer that inherits the lifetime lease and survives an unexpected
owned server SIGKILL. With the stale socket removed, quiesce, checkpoint and
explicitly approved continuation must reject while that writer still modifies
source; after its actual exit, checkpoint and a newly approved continuation
succeed. This differs from graceful server termination, which killed the child
in the characterization. Unavailable and missing-pane observations clear current
process fields and carry a fresh observation time. The existing restore-readiness
contract remains durable before launch, including when launch acknowledgement is
lost; readiness records completed gates rather than observed agent activity.
