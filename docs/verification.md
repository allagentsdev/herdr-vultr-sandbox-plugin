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

Confirmed inactivity adds focused `idle-expiry`, `expiry`, `activity`,
`expiry-service` and `ssh-timeout` tests. The first new regression called the
existing create path with approved policy and a failing controller dependency;
it failed with a missing expected `controller_unavailable` rejection before
production changes. The local checks cover exact-worker consent, 15 minutes of
unchanged idle evidence, working/blocked/unknown protection, changed/stale reset,
fresh final activity checks, fixed 15-minute deferral, new bound Resume/restore
sessions, stale jobs, failed Resume writers and unknown-outcome reconciliation.
Vultr-specific fixtures require bodyless Halt, fresh OFF, exact image description,
complete state, positive size, OS/checkpoint checks, ownership and no attached
blocks. Good images survive failures.

Service tests replace supervisor commands with owned adapters and write unit
definitions only under temporary fixture homes. A temporary controller child
starts through that adapter, persists a deliberate missing-fixture-token failure,
restarts and preserves the session; cleanup asserts owned children exited. No
actual systemctl/launchctl service is installed. SSH tests exercise the real class
with fake process boundaries: controller 120 seconds, readiness 20 seconds, normal
commands five minutes, interactive attachments without a command deadline and
typed timeouts. Guest activity uses the existing helper inspect contract and
actual persisted identities; the native helper is unchanged.

These are local source and process checks. They do not prove authenticated
automatic Vultr hibernation/restore, actual host-service installation, offline-host
enforcement or macOS execution. Those remain separate conformance work.

`test:herdr` uses a named disposable server with isolated XDG config/state/cache
and its own explicit socket. It never routes through the active-session shim.
It links the plugin only into that isolated configuration, checks real foreground
hints, `agent prompt --wait`, session metadata, hint revocation, installed
onboarding, persistent dashboard and IPC reconnect, then stops its owned server.
The agent UI and SSH/provider endpoint are synthetic. The current host active
session and global installation are not test targets.

Creation tests exercise explicit `new-worker` and normal positional CLI/manifest
dispatch. They retain ready worker A while creating provisional B with a distinct
UUID, home, artifacts and upload destination. Both provisional workers reach the
original exact digest review without provider submission. Tests also cover
source ambiguity, explicit retries, direct dashboard authority, unknown pane-open
outcomes, and missing-config setup routing with separate malformed, invalid,
required-field, private-file and missing SSH-key failures. Injected pane receipts
and provider services in Node tests are synthetic; they do not establish installed
Herdr caller context or live provider behavior.

The installed harness invokes Start and New worker through a genuine caller pane
on its owned server, then correlates the new action log and `VULTR_RESULT`.
It selects the owned source workspace, verifies the focused pane/cwd and actual
action context, and restores the previous workspace/focus after dispatch.
First Start reaches setup with no mapping. Malformed JSON and missing dummy SSH
key stay typed failures. Two independent workers remain at exact upload review;
the harness never types approval. Harmless placeholder credentials live outside
the synthetic Git source. A Node preload rejects and records unexpected fetches
without supplying provider results, and the harness verifies both installed Node
entrypoints inherited it. Installed worker/pane/source/home/digest receipts print
with the result for the caller to retain. This proves no provider request before
approval within that isolated fixture, without authenticating or allocating.

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
confirmed no residual instance, block or reserved IP. The follow-up below also
verified legacy retained-image restore; native snapshot restore remains untested.

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

The boundary tests above are local synthetic evidence. The subsequent bounded
2026-11-18 live follow-up exercised exact tested commit
`518332fc932a8f4e8d096d0a0bf1599ae1ad474c`, whose tree matches merged
`fddb2c09c5cb823eab65b1d43b8c32cf70e6de05`. It used legacy tmux logical worker
`23e22bfd-a785-4208-a679-8dddf47f8801`, not a fresh native worker.

- Normal Stop of `c319e036-2ab4-429d-a0ad-b849be308e63` checkpointed at
  04:37:32.245Z and freshly observed provider `stopped/ok` at 04:37:37.538Z.
  Control request `8f44d9ec-6eef-4e4c-bde0-e1b1fc114ec5` completed; exact power
  operation `2c905a3e-b939-40e4-86d2-d49e0d666820` has distinct attempt and
  acknowledgement receipts. No manual provider reconciliation was used.
- Allocated Resume preserved that exact instance/IP, checkpoint, all four source
  hashes and authenticated guest state, with a new boot. Normal Hibernate then
  observed provider OFF and created complete image
  `d498987f-21c9-4b8b-aeeb-f270c78be2e9`, operation
  `771409a3-3211-41fa-a2e9-72ec3f73ac69`. Normal Recover reconciled the known
  image without another create, followed by exact approved release.
- Restoring retained legacy images was observed: original
  `f053bd82-c252-45e6-92e1-bacf267926d3` to the first instance, then `d498...`
  to `a5f5ce1b-d6d6-492a-8121-d95b2faa6218`. Source digest
  `441f4d8b6396a4d0fe433fac036bafead2673200872dcdc9b9d3d759c6686cb9`,
  all four source file hashes, checkpoint and authentication status matched.
  Both images remained complete, OS 2284, size 59055800320 bytes.
- The second allocation resulted from an invocation mistake: Start was typed in
  a new source pane while the legacy dashboard was selected. The stock action
  CLI used its actual focused context, recorded in plugin-log-14. The invoker
  had not selected the intended workspace; no stock/core/plugin defect was
  established. The proposed native fixture was never approved or uploaded.
- Both instances were normally stopped and deleted through exact-target reviewed
  approvals before the 05:28:30Z trial target. Final 05:18:25Z inventory contained
  no instances, blocks or reserved IPs. Both recovery images were retained;
  images remain sensitive authenticated state and separately billable storage.

Private evidence remains outside Git under the run label
`provider-stop-followup-20261118`. Receipt references are
`legacy-normal-stop-proof.json`, `legacy-allocated-resume-proof.json`,
`final-operation-receipts.json`, `provider-1794978095527.json` (first instance
absence), `provider-1794979100540.json` (second absence), and
`preflight-1794979105491.json` (final empty inventories and retained images).
The earlier guest-only Stop discrepancy and separately authorized reconciliation
remain historical evidence; they are not presented as success of the old code.

These observations establish legacy provider/source/auth recovery only. They do
not establish fresh native guest-Herdr cloud creation, prompt/wait, lifecycle or
snapshot restore, or blanket DX parity. A separate fresh native worker still
needs independent source approval, home, login and trust. No credentials or
private authentication logs are included here, and no additional cloud retest
was performed for this documentation update.

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

The idle port also has a bounded integration observation against an owned stock
Herdr 0.9.5 server and the unchanged deployed guest helper. The synthetic
terminal fixture used a recorded 10-second work hold. Production `Remote.activity`
polled the real helper through a local adapter that changed only deployment roots;
there was no SSH network connection. Exact worker/session/short-socket and native
pane/terminal identities matched. Actual `agent.get` sequence advanced 1 → 2 → 3
with idle → working → idle observations; mismatched identity remained unknown,
and confirmed child exit was observed. No extra pane reads or direct agent queries
preceded working detection in the accepted run. An earlier 3-second timeout remains
inconclusive, and a separate diagnostic run with extra reads is retained separately.
This checks the local native observation boundary, not authenticated agent behavior,
cloud hibernation, real host-service installation, macOS execution or provider-owned
expiry. The original helper process/PTY proofs remain separate and unchanged.
