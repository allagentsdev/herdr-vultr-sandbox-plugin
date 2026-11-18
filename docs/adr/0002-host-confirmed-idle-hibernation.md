# Host-confirmed idle hibernation

Accepted 2026-11-18. One logical worker retains its identity and recovery images
across separately identified compute-allocation sessions. Automatic release uses
exactly 15 minutes of continuously confirmed inactivity. Working, blocked and
unknown activity is protected. A changed idle token, a reversed clock or an
observation gap over 90 seconds starts a new idle window. No fixed active-work
lifetime is introduced. An explicit operator deferral adds 15 minutes to the
candidate expiry floor without weakening these activity requirements.

New source approval discloses recurring checkpoint, snapshot and exact-instance
deletion for the displayed worker UUID. Existing upload approvals gain no policy
through an upgrade; enabling or disabling requires exact-worker confirmation.
Configuration selects 15 minutes or disables the new-worker default. Every new
allocation and Resume/restore persists a fresh unknown-activity session before
new compute is requested, then binds it to the actual Vultr instance ID. Jobs
check the current session and instance under the same worker lock. Reconnect
preserves observations; a stale job cannot act on a replacement allocation.

A durable Linux systemd user service supervises a controller independently of
the dashboard. Its private stable launcher points to the installed plugin
entrypoint. The service must confirm a live heartbeat before a consented
allocation or power-on. The controller persists observations and runs bounded
per-worker jobs; errors remain visible with retained resource state. Controller
SSH commands use the actual transport's 120-second default; readiness overrides
it with 20 seconds, and interactive login/attachments keep their own lifetime.
The source includes launchd definition generation, but the plugin remains Linux
only and macOS execution is unverified.

Native activity reuses Vultr's existing guest helper inspect operation. Its
private environment owns `state/herdr.sock` and `worker-<UUID>`; no Hetzner socket
path or owner-PID model is imported. Host classification checks the persisted
worker, session, workspace, pane and terminal, plus the detected agent kind and
state-change sequence. A confirmed foreground exit is idle only with matching
identity and an observed shell PID. Missing metadata, transport/authentication
failure and detached silence remain unknown. Legacy tmux has no automatic idle
evidence without a configured application probe. Background services require an
application-aware probe; it takes precedence over coding-agent state, and failed
probes stay unknown. Only bounded states and hashed tokens are persisted by the
activity classifier; arbitrary agent metadata and raw custom tokens are not
added to controller logs or policy observations.

Immediately before automatic quiescence, activity is checked again. Automatic
release then uses the existing Vultr lifecycle: quiesce, durable source
checkpoint, cloud-init clone preparation, bodyless exact-instance Halt, fresh
provider OFF, exact-description complete snapshot with positive size and the
frozen OS/plan/disk/checkpoint checks, then exact-instance deletion. Ownership and
block inventory checks remain authoritative. A consented manual Stop records
the same current quiescent checkpoint and clone preparation before Halt, allowing
later release of the OFF instance without powering it on. Disabled-policy Stop
keeps its existing behavior. Resume retires old Hibernate authority before any
power-on or already-running settlement, including failed restart-hook writers.
Completed manual Stop retains a durable intent bound to its exact instance,
checkpoint and power receipt; completion is recorded atomically with clearing the
pending receipt after provider OFF. After no pending receipt remains, exact-worker
Disable additionally requires fresh owned provider OFF before revoking recurring
release and retiring that manual Stop authority in one durable update. A rejected
Halt, interrupted Hibernate or legacy unmarked shutdown stage cannot establish
manual Stop completion. Hibernate takeover durably retires manual Stop authority
before continuing, including before provider observations. Running, transitioning,
missing or unconfirmed observations retain policy and recovery. Disable without
Hibernate authority does not read the provider.
The latest checkpoint remains as `powerCheckpoint` for observation, without
authorizing release; the stopped instance and previous snapshot remain unchanged.
Pending receipts and snapshot, release or unknown Hibernate stages still block
Disable.

Attempt, acknowledgement and observation receipts remain separate. Unknown
create, power, snapshot or delete results never authorize duplicate mutation.
Previous good images are retained when a new image or release fails; image
pruning, reserved-IP adoption/cleanup, attached volumes and shared placement stay
outside this change. Manual release retains exact instance/image confirmation;
automatic release uses the saved recurring authorization for the current bound
session and verified image.

The host keeps management credentials and the client private key. Guest code and
snapshots gain no management authority. Agent authentication remains sensitive
guest disk/snapshot state. The host service survives pane and Herdr exits, but
cannot enforce release while the host is offline or its user service is stopped.
Fresh idle evidence is required after stale gaps; already quiesced authorized
operations can reconcile. Resource retention on failure means this is neither a
hard spending cap nor provider-managed expiry.

The reviewed reference is immutable Hetzner commit
`df8cb6ce81504581be48c10f7f8b4af55df8ab2f`, including the idle-controller change at
`1aba7b38f55325f10de9d8b2237a3e25412e47b2`. Provider-independent contracts are
adapted to Vultr string IDs, Halt/OFF semantics and actual guest observations.
Reference provider conformance does not transfer. Local deterministic lifecycle,
fake supervisor, isolated controller and SSH-boundary tests cover this feature;
authenticated automatic Vultr release/restore and macOS service execution remain
pending.
