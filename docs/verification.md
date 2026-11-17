# Reproducing validation

Use a Linux host with Node 22+, Git, OpenSSH, tmux and an actual official Herdr
0.9.5 binary. Keep all generated output and logs in a private directory outside
Git. Run from this checkout:

```sh
npm ci
npm run check
VULTR_HERDR_TEST_BIN=/absolute/official/herdr npm run test:herdr
npm run test:package
```

`check` runs formatting, ESLint, manifest validation and Node tests. The tests
exercise fake provider contracts, real Git/source receivers, isolated tmux,
private socket ownership, exact approvals and recovery. No Vultr credential is
read and no Vultr resource is created by them. The reference source/patch
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

## Opt-in live observations — pending

No live run is authorized by this implementation task. After separate explicit
owner authorization, an existing worker can be observed without resource mutation:

```sh
npm run test:live -- --allow-live-conformance --dedicated-account \
  --worker EXACT_WORKER_UUID --server EXACT_VULTR_INSTANCE_ID
```

Supply `--snapshot EXACT_SNAPSHOT_ID` only to inspect the worker's already saved
snapshot. The script checks exact durable IDs before reading the token, observes
provider ownership/power, performs strict pinned SSH source/identity/tmux checks,
and discards remote output. It never starts, halts, rebuilds, creates or deletes
resources. Successful output is a limited observation, not full lifecycle or
authenticated-agent conformance. The broader trial checklist is in the capability
matrix. Deletion always remains an exact-target user approval in the dashboard.

Private logs for this implementation are retained outside Git. The PR records
check counts, official binary version/hash, production package smoke and the
actual independent review receipt. Live Vultr and authenticated coding-agent
conformance remain explicitly pending.
