# Herdr Vultr Sandbox

Persistent Linux coding workers for Herdr, plugin ID `vultr.sandbox`. One logical
worker has one dedicated Vultr Cloud Compute instance. A worker UUID survives
power-off and snapshot restore; instance and snapshot IDs are separate resources.
Closing a pane disconnects the UI and leaves the worker and billed allocation.

This is a candidate implementation. An owner-authorized live trial verified the
merged legacy worker's bootstrap, independent Codex login and allocated resume,
plus separate native guest Herdr/Codex process proofs. **Full lifecycle
conformance remains open**, including live verification of the provider Stop correction below and
the complete fresh-worker native Herdr path. Local fake-provider tests and
isolated actual Herdr 0.9.5 contracts remain separate evidence.
See [capabilities](docs/capability-parity.md), [architecture](docs/adr/0001-vultr-worker-lifecycle.md)
and [verification](docs/verification.md).

## Requirements and setup

Linux host: Node.js 22+, npm, OpenSSH client/keygen, Git, Herdr 0.9.5+. Guests are
Ubuntu 24.04 LTS x64 (`osId: 2284`) on `vc2` plans. The default candidate plan is
`vc2-2c-4gb`, region `syd`; verify account availability and costs before allocation.
Windows/macOS hosts, alternate guest images, attached storage and shared VM
placement are unsupported in this release.

The repository is private. After review, the owner can install through Herdr's
plugin manager from `allagentsdev/herdr-vultr-sandbox-plugin` or use a local link.
These commands are documentation for an explicitly authorized owner setup:

```sh
npm ci
npm run check
herdr plugin link /absolute/path/to/herdr-vultr-sandbox-plugin
```

Use a dedicated Vultr account/API key with appropriate API source-IP restrictions.
Vultr's account API token is not a Hetzner project-scoped credential. The plugin
never retrieves tokens, changes account policy or creates a provider SSH-key
registry entry. Supply only a dedicated public client key through authenticated
cloud-init; its private counterpart stays host-side.

Create private files **outside every uploaded worktree**. Use a dedicated
unencrypted client key because unattended batch SSH cannot unlock a passphrase
or use an ambient host SSH agent. Token/config/private-key files must be owned
regular files, mode 0600; directories should be 0700. Do not paste a token into
command history. Populate the token file using your own credential manager.

```sh
install -d -m 700 /absolute/private/vultr
ssh-keygen -t ed25519 -N '' -f /absolute/private/vultr/client_ed25519
cp /absolute/plugin/examples/config.json /absolute/private/vultr/config.json
chmod 600 /absolute/private/vultr/config.json
```

Edit the example's absolute paths. Put `config.json` in Herdr's plugin config
directory (reported as `HERDR_PLUGIN_CONFIG_DIR`), or use Configure Vultr from
the action picker. Onboarding asks for file paths and agent selection; it only
checks key pairing and GET access. It does not allocate compute or prove write
permission. No global configuration is changed by these example templates.

First Start Agent or New Vultr worker opens this setup pane when `config.json`
is missing, without creating a worker or allocating compute. Invalid configuration
and missing credential files remain failures; fix those files explicitly.

Before manual CLI use, supply the same plugin config/state/session environment
as the intended Herdr caller, including an explicit `HERDR_PANE_ID` or plugin
caller context. Never target another client's focused pane. Herdr supplies
`HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR` and
`HERDR_PLUGIN_CONTEXT_JSON` to installed actions.

```sh
node /absolute/plugin/src/action.mjs check-config
node /absolute/plugin/src/action.mjs new-worker
node /absolute/plugin/src/action.mjs list
node /absolute/plugin/src/action.mjs info --worker EXACT_WORKER_UUID
node /absolute/plugin/src/action.mjs reconnect --worker EXACT_WORKER_UUID
```

The first stdout record is `VULTR_RESULT <JSON>`. `opened` means a pane launched,
not that remote setup completed. The receipt includes the exact new `paneId`. `list`, `info`, `status` and `check-config` are
observations; they do not start compute. Explicit UUID selection resolves an
ambiguous mapping. A live busy owner returns `busy` rather than typing into its
agent. A private socket and process-lifetime lease retain one dashboard owner.
Accepted dashboard requests return a `requestId`; `info` exposes the latest 20
`controlRequests` with queued/running/completed/failed/cancelled/interrupted
status and a safe code. Poll that exact request ID. An interrupted request is
never automatically replayed. A completed reconnect means its handler returned;
consult transport/provider state for the remote process and allocation.

`herdr plugin action invoke ACTION --plugin vultr.sandbox` uses the focused pane
of its selected Herdr session. Before running it from a background terminal, use
a supported control such as `herdr workspace focus WORKSPACE_ID`, verify the
intended pane and cwd, and restore the previous focus after dispatch.

Start Agent and Reconnect reuse the selected worker. Choose **New Vultr worker**
to create another independent worker for the same checkout and workspace. It gets
a fresh UUID, dashboard pane, remote agent home, source directory and dedicated
instance after its own exact upload approval. It never copies another worker's
login or shares its VM. `new-worker` cannot be combined with `--worker`;
retry a provisional worker with `start-agent --worker EXACT_WORKER_UUID`.
With multiple workers on one source, Start requires explicit UUID selection.
A worker's own dashboard continues to select that worker even when another
worker was created from that dashboard. If pane creation has an unknown result,
inspect `list` and Herdr panes, then retry the retained UUID explicitly.

## Reviewed source and unattended SSH onboarding

Start Agent displays the complete eligible manifest, paths, sizes, modes, file
hashes, total bytes, destination and billing notice. `UPLOAD <exact SHA256>`
approves those immutable staged bytes and new billed allocation. Filters always
exclude Git metadata, ignored files, all `.env*` (including examples), known
credentials/private profiles, symlinks and recognized credential content.
`uploadExcludes` adds path exclusions; it cannot override mandatory exclusions.
Review ordinary source for secrets the filters cannot recognize.

Before create, the plugin generates a fresh **server host identity**, saves its
public pin in a durable operation record and sends its server key through the
authenticated Vultr cloud-init API. Base64 encoding is transport encoding, not
encryption. User-data is retained by Vultr and on guest disk; account and private
state access are sensitive. The **client private key** and management token are
never uploaded. `ssh_keys` is supplied without the invalid empty
`ssh_genkeytypes: []` field. SSH password login is disabled and the intended
public client key is installed explicitly for root.

All SSH connections use strict per-instance pins, isolated known-hosts, no host
SSH configuration, no SSH agent and no forwarding. New boxes need no console or
fingerprint ritual. A bounded pinned readiness wait handles boot delay without
weakening trust. Noninteractive SSH commands have a five-minute deadline
(with shorter readiness probes) and server-alive checks; a timeout may leave a
remote command applied and never grants blind lifecycle replay. Interactive
owner login and agent attachments have a separate lifetime. If provisioning does not apply the expected key, the connection
fails closed. `pin-host` is an explicit console-verified recovery surface for a
missing saved pin; it does not replace an existing provisioned pin.

A definitive rejected provider mutation retains a terminal
`lastRejectedOperation` and permits the next explicit retry after rechecking its
target and approvals. Timeouts, conflicts, incomplete responses and server
errors retain the pending operation and never get that retry permission.
Unknown create responses retain the operation/pin and search exact Vultr tags;
there is no blind second POST. A missing mapped instance never grants replacement
permission. Recover observes submitted operations; ambiguous/unobservable
outcomes require account inspection and keep billable resources visible.

## Agents and public Compound

Built-in candidates are `codex`, `codex-compound` (0.169.0), `claude-code`
(2.1.220), and `opencode` (1.18.9). Versions and commands freeze per worker.
`allowCandidateAgents: true` explicitly opts into unverified profiles.
Each has a dedicated remote home and tools directory. The owner completes agent
login **on the remote worker**, including any device-login/trust prompts. The
plugin never copies host account/auth files, private skills or private profiles,
and never answers trust/approval prompts for the owner.

`codex-compound` installs the public native Compound plugin at
`d8f8e03237bded06e77bcb3930b43ef841e7eeda` (3.38.1). Its modern named profile is
`compound-engineering.config.toml`, without permission overrides or legacy
`[profiles.*]` tables. Account-linked plugin sync still belongs to owner login.

Declarative custom agents use `agentKind` plus `customAgents.<kind>` with
`title`, `installationCommand`, `launchCommand`, `resumeCommand`,
`versionCommand`, `expectedVersion`, `authenticationMode`,
`authenticationCommand`, `authenticationCheck`, `herdrDetectionIdentifier`,
`interactiveTTY: true`, and `resumeSupported: true`. Resume and authentication
commands/check may be omitted where the adapter contract allows CLI-managed
behavior; an omitted check is not proof of authenticated access. `agentArgs`
maps an agent kind to a quoted string argument array. Commands and service hooks
are trusted remote root code. Unknown fields are rejected.

The six `adapter` hooks (`install`, `authCheck`, `launch`, `resume`, `quiesce`,
`restart`) also support custom commands; raw adapters require nonempty launch,
resume and authCheck. Built-ins may use service quiesce/restart hooks. Configure
repeatable service flush/stop and restart commands when the work needs them.
Filesystem snapshots alone do not establish application consistency.

## Dashboard and lifecycle

The live trial found that guest shutdown acknowledgement and disappearing SSH
did not establish provider OFF. Normal Stop and Hibernate now quiesce the agent
and configured services, persist a flushed source checkpoint, then submit Vultr's
exact provider Stop (`POST /instances/<ID>/halt`) and poll fresh provider state.
Hibernate also cleans and flushes cloud-init's clone cache before Stop. This is
one normal provider operation, with durable intent and a separate acknowledgement;
it is not a guest-shutdown fallback. Application consistency depends on the
configured quiesce hooks and checkpoint, not an assumed provider OS shutdown
behavior. Local tests cover this correction; an authorized live trial remains
pending. See the [verification limits](docs/verification.md#live-provider-stop-gate).

New logical workers run pinned stock Herdr 0.9.5 on the guest, with a private
`worker-<UUID>` session and durable state under the worker directory. Reconnect
attaches its existing native terminal; `Ctrl-b q` returns to the dashboard and
`Ctrl-b Ctrl-b` sends a literal `Ctrl-b`. Actual guest workspace, pane, terminal,
process and detected agent observations, with their observation time, are exposed
in worker info. A running
process is not evidence that the agent is ready for input. When the actual child
exits, only the attachment client closes and the dashboard returns; guest Herdr
and its terminal remain available for observation and explicit restart.

Existing records without a backend marker retain explicit legacy tmux recovery;
`Ctrl-b d` detaches those workers. They are never silently migrated or relaunched.
Restart Agent requires `RESTART <worker UUID>` and refuses a live process.
After guest server loss, Resume verifies identity/auth/services before the
configured continuation can run. A one-use Resume gate is consumed before setup;
ordinary Reconnect cannot use a leftover gate. An inherited writer lease blocks
checkpoint or continuation while an owned child survives guest server loss.
Herdr restore cannot automatically resume agents. Guest Herdr config/state/cache/runtime and socket belong only to this
worker; ambient host session/socket defaults are discarded. Strict SSH and
independent guest agent login remain in force. The dashboard is never an agent
input target. Local continuation metadata contains the absolute reconnect command,
never an invented native conversation ID.

| Control          | Behavior                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Stop             | Quiesce, durable source checkpoint, exact provider Stop, poll fresh Vultr OFF; still billed                                 |
| Resume allocated | Start only a confirmed stopped instance, then pinned SSH/auth/services; running instances are not restarted                 |
| Hibernate        | Quiesce/checkpoint, clean cloud-init clone cache, provider Stop and fresh OFF, snapshot checks, then exact release approval |
| Release          | `DELETE <instance ID> SNAPSHOT <snapshot ID>`; cancelled approval retains the off, billed instance                          |
| Resume snapshot  | New instance/host pin on the same frozen plan; verify worker/checkpoint/source/auth and run restart hooks                   |
| Delete server    | Exact `DELETE <instance ID>`; intentionally destructive disk deletion; snapshots retained                                   |
| Replace / Forget | Exact deletion or unallocated-worker approval; mappings change only after confirmed deletion; recovery history retained     |
| Recover          | Observe retained create/power/snapshot/delete receipt without duplicate submission                                          |
| Apply changes    | Validate returned source/patch receipt and exact `APPLY <digest>`; preserve host index and unrelated local changes          |
| q / pane close   | Close local control surface only; no cloud deletion or stop implied                                                         |

Vultr returns no Hetzner action IDs. A durable receipt records operation UUID,
submission intent/time, exact resource and acknowledgement; observed state
settles it. Instances use exact ownership/operation tags; snapshots use an exact
operation description because snapshots have no tags. Snapshot completion is
`complete`, not `available`. Blocks come from separate account inventory and
block lifecycle mutations. Start can restart a running instance, so it is never
sent speculatively. The plugin submits exact-instance `/halt` for Stop after application quiesce and
checkpoint. It never submits bulk halt, reinstall/rebuild or automatic mutation retries.
Historical guest-shutdown receipts only observe their retained target; they never
authorize a new provider Stop. An acknowledged request still requires observed OFF. Operator changes during a transition can leave a receipt requiring manual
inspection; this favors retained data over automatic convergence.

Power-off is still billed. Hibernation exchanges instance charges for separately
billed snapshot storage, restore latency, a new instance/IP, and lost RAM/process
state. Snapshots contain independently authenticated agent credentials and must
be protected as sensitive account data. No automatic snapshot pruning, reserved
IP/block creation/cleanup or pricing promises. Dedicated worker paths prepare a
future shared-VM design; they provide no tenant isolation and no shared placement
is implemented.
