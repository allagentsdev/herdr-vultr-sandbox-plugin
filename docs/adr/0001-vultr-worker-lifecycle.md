# Dedicated Linux Vultr workers and authenticated first connection

Accepted for the candidate Linux implementation, 2026-11-18. Live provider and
remote-agent conformance remain pending.

Subsequent authorized live evidence leaves a specific provider gate open:
guest-only graceful shutdown did not produce provider OFF. Separately authorized
exact provider Stop (`/halt`) reconciliations were required. Native guest Herdr
does not correct that behavior, and this transport decision adds no automatic
provider fallback or mutation retry. Full lifecycle conformance must not be
inferred from guest transport, authentication or allocated-resume proofs.

## Decision and evidence

Use one dedicated Vultr Cloud Compute instance per logical worker. Keep worker
UUID, instance ID and snapshot ID separate. Reuse provider-independent plumbing
from the exact merged Hetzner commit
`c5a3249f7538ecd9959c0222f95f2042af3e680c`, retaining MIT attribution and tests.
Do not carry Hetzner action, image, Primary IP, project or label contracts into
Vultr. The supplied checkout was at a different HEAD; a read-only git archive of
that exact object was used. No other provider was edited.

Contract choices were made against these primary sources on 2026-11-18:

- [Official govultr instance contract, pinned
  `8e5e0d2f21081aaea710efb2a4bd6c5a1eca7d28`](https://github.com/vultr/govultr/blob/8e5e0d2f21081aaea710efb2a4bd6c5a1eca7d28/instance.go):
  string IDs, region/plan/os_id/snapshot_id, tags, user_data, Start/Halt and
  separate status/power_status/server_status. Start may restart a running box.
- [Pinned snapshots](https://github.com/vultr/govultr/blob/8e5e0d2f21081aaea710efb2a4bd6c5a1eca7d28/snapshot.go),
  [blocks](https://github.com/vultr/govultr/blob/8e5e0d2f21081aaea710efb2a4bd6c5a1eca7d28/block_storage.go)
  and [cursor metadata](https://github.com/vultr/govultr/blob/8e5e0d2f21081aaea710efb2a4bd6c5a1eca7d28/meta.go):
  snapshots have descriptions rather than instance tags; attached blocks need a
  separate inventory. No lifecycle action-ID resource is exposed by these calls.
- [Vultr cloud-init guide, updated 2026-11-13](https://docs.vultr.com/how-to-deploy-a-vultr-server-with-cloudinit-userdata/):
  authenticated API user-data is base64 encoded and retained/readable later.
- [Canonical cloud-init 25.3 SSH module](https://docs.cloud-init.io/en/25.3/reference/modules.html#ssh)
  and [CLI clean](https://docs.cloud-init.io/en/25.3/reference/cli.html#clean):
  supplied ssh_keys suppress separate generation; clean permits clone
  reinitialization. Never emit schema-invalid `ssh_genkeytypes: []`.
- [Vultr snapshot and redeploy guide, updated 2026-04-15](https://docs.vultr.com/how-to-take-a-snapshot-and-redeploy-a-vultr-compute-instance):
  whole instance disk and equal-or-larger destination storage. Snapshot API has
  no architecture field; preserve the same frozen `vc2` plan and recorded disk
  rather than inventing an architecture claim.
- [Official Ubuntu 24.04 catalog example](https://docs.vultr.com/how-to-provision-cloud-infrastructure-on-vultr-using-terraform):
  OS 2284. Other guest images are rejected until their bootstrap is verified.
- [Stopped instance billing](https://docs.vultr.com/support/platform/billing/are-stopped-instances-still-billed-on-vultr)
  and [snapshot billing](https://docs.vultr.com/support/platform/billing/does-vultr-charge-for-stored-snapshots):
  allocation remains billed while off; snapshot storage is separately billed.
- [Herdr 0.9.5 source tag](https://github.com/herdrdev/herdr/tree/7573e821895d32c8d1f78b3f6c9a2f85a46df4ac)
  and [public Compound source](https://github.com/EveryInc/compound-engineering-plugin/tree/d8f8e03237bded06e77bcb3930b43ef841e7eeda):
  explicit caller context, foreground hints and absolute session continuation;
  public native plugin and modern Codex profile with no permission escalation.

The official API documentation at `www.vultr.com/api/` returned HTTP 403 in this
research environment. Pinned official SDK wire definitions and public Vultr
product guides supplied the contracts; no mirror or third-party API was used as
an implementation authority. These are code/document contracts, not an account
availability or live behavior receipt.

## Onboarding and trust

A normal new instance must not require provider-console commands or TOFU.
Generate a purpose-specific server ed25519 key before create, durably associate
its public pin with the operation, and inject the pair through authenticated
cloud-init. Install the intended public client SSH key explicitly, disable SSH
password auth, and keep the client private key and account API token host-side.
The provider retains user-data, so a server private key is visible to trusted
account/provider actors and stored in protected local provisioning artifacts.
That server key cannot authorize client login. This is an explicit tradeoff for
an authenticated unattended first connection. Pins never transfer from old
instances to restores. Strict checking and no forwarding apply on every attempt.

Before cloning, quiesce services and the agent, capture durable source/checkpoint
outside the worktree, clear cloud-init's per-instance cache, and shut down
cleanly. A restore gets new user-data and a fresh pin, then verifies persisted
worker identity, checkpoint/source digest, agent auth and service restart hooks.
If Vultr or cloud-init does not apply the expected key, strict SSH fails closed;
no stale-key fallback occurs. Real snapshot restore onboarding remains a pending
live conformance item, not an inferred guarantee from mock tests.

Remote coding agents authenticate independently. Never copy host private skills,
profiles, account files or login credentials. Public Compound installation is
pinned; owner login supplies account-linked state. Never answer a trust or
approval prompt automatically. Versioned built-ins remain candidates; custom
commands are trusted operator root code, not an isolation mechanism.

## Operations, identity and recovery

Persist intent before every external mutation. Vultr's create returns an
instance, and start/delete return acknowledgements, without action IDs. Exact
instance operation tags and snapshot descriptions let an unknown create or
snapshot reconcile without duplicate POST. Power and deletion reconcile only
observed target state; missing/unobservable state retains the receipt and
allocation. GETs follow opaque cursor tokens against the fixed API origin;
redirects are rejected and response bodies are never logged. Definitive rejected
mutations retain a terminal rejection receipt and permit a subsequent explicit
retry with fresh target/approval checks. Timeout/conflict and unknown responses
keep pending intent. Noninteractive SSH has bounded command deadlines and
server-alive probes; a timeout does not prove nonexecution. Interactive owner
login/attachment remains separately controlled.

Pane-open receipts identify the exact created pane. Queued dashboard actions
have correlated request IDs and the latest 20 receipts in worker info, including
safe failure/cancellation codes. A new owner marks abandoned requests interrupted
without replay. Completion of a UI handler does not imply successful provider
allocation or a healthy remote agent; callers inspect those states separately.

Never silently allocate a replacement for a missing live mapping. Resume from a
saved snapshot is an explicit caller action and retains the logical worker UUID.
Replace creates a new provisional worker only after exact approved deletion,
then requires a new source approval. Snapshot/pin identities do not imply worker
identity. An operation is not complete because a pane closed or a transport
failed. Host checkout/index state is never cloud deletion authority.

Use a pinned guest shutdown after quiesce/checkpoint, then confirm Vultr power
state. Do not call force halt and describe it as graceful. Start is sent only
for a confirmed stopped instance because it may restart one already running.
Hibernation requires completed exact-operation snapshot and the durable
checkpoint before a separate exact-instance-and-snapshot release approval.
Cancellation or failure keeps the off, billed instance and previous snapshot.
Plain explicit Delete is intentionally disk-destructive and does not imply
hibernation or snapshot creation. Cleanup never deletes retained snapshots.

## Cost, storage and future placement

Power-off keeps compute allocation and its bill. Snapshot-based hibernation can
reduce long-pause compute cost but adds billed snapshot storage, new-instance/IP
allocation, restore latency, capacity risk and loss of RAM/process state. No
fixed price or break-even claim is part of the contract. Snapshots include
remote credentials and disk services; protect account access accordingly.
Attached blocks are unsupported and block lifecycle mutations. Reserved IPs,
external storage and automatic snapshot pruning are outside this implementation.

Worker UUID directories and separate physical-resource records leave room for
future workers sharing a VM without implementing placement now. Such a system
must separately isolate source, credentials and services, track all occupants,
and require all workers to quiesce/checkpoint before physical shutdown/deletion.
Directories and containers are not VM tenant isolation. Today each worker owns a
dedicated guest and root account; no multi-tenant security claim is made.

## Consequences and rejected alternatives

Reject TOFU/disabled host checking, borrowed host agent auth, Hetzner-shaped API
emulation, forced-shutdown hibernation, blind POST retries, silent rebuild,
automatic snapshot deletion, and focused-pane inference. Keep a persistent local
dashboard separate from SSH/agent/compute lifetimes. New logical workers use pinned stock guest Herdr 0.9.5 and persist actual
workspace/pane/terminal IDs and detected agent observations. Missing backend
markers select legacy tmux recovery without migration. Dead workers remain
observable and explicit restart refuses a live process. The guest helper clears
inherited HERDR variables, sets HERDR_SESSION and the exact short worker socket,
and never passes --session (which overrides that socket in 0.9.5). Private durable
XDG state/config/cache/runtime live under the worker state directory. Native
restoration has resume_agents_on_restore=false; server startup never grants
agent continuation permission. Existing identity/source/auth/service gates
produce one-use continuation approval, consumed even when the agent is already
live. Server loss retains a durable Resume requirement. Local fake-provider tests,
real tmux checks, actual isolated Herdr contracts and package smoke support only
the claims in the capability matrix. Production deployment and live conformance
need a separately authorized owner trial.
