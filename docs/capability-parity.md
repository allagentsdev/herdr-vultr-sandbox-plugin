# Capability and parity evidence

Baseline: exact merged Hetzner
`c5a3249f7538ecd9959c0222f95f2042af3e680c`. Its capability matrix, ADR, tests,
MIT notice and immutable installed checkout were inspected as references. This
port retains its provider-independent workflows and source attribution. No
Hetzner or Vercel live verification transfers to Vultr.

Herdr contract: official 0.9.5 binary, source tag
`7573e821895d32c8d1f78b3f6c9a2f85a46df4ac`. Public Compound: 3.38.1,
`d8f8e03237bded06e77bcb3930b43ef841e7eeda`. Vultr wire definitions: official
`vultr/govultr` `8e5e0d2f21081aaea710efb2a4bd6c5a1eca7d28`.

“Local” below means runnable repository evidence. The Herdr test starts an actual
owned server using a synthetic Codex-shaped TUI and fake provider/SSH boundaries.
It is neither a live provider test nor an authenticated coding-agent trial.

| Capability                                                      | Vultr implementation and runnable evidence                                            | Difference / limitation                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path-only onboarding, strict config                             | `onboarding`, `config`, `adapters` tests                                              | Account token, not a Hetzner project credential; GET check never proves create permission                                                                                                                                                   |
| Dedicated logical worker identity                               | `mappings`, `actions`, `connections` tests                                            | Worker UUID differs from string instance/snapshot IDs; no shared placement                                                                                                                                                                  |
| Explicit independent worker on the same checkout                | `actions`, `mappings` tests; installed action harness                                 | New worker gets its own UUID/home/pane and exact upload approval; ordinary Start selects existing workers, with explicit UUID selection for ambiguity; fresh native lifecycle remains pending                                               |
| First connection without console                                | `host-identity`, `ssh`, `remote` tests                                                | Server key via authenticated base64 cloud-init; client private key host-side; merged legacy guest bootstrap verified, fresh native lifecycle pending                                                                                        |
| Boot readiness                                                  | `Remote.waitReady`, `connections` tests                                               | Strict pin on every attempt; never TOFU or stale-pin fallback                                                                                                                                                                               |
| Exact source approval/exclusions/upload                         | `manifest`, `remote`, `actions` tests                                                 | Immutable staged digest, full manifest; no sensitive-file override; arbitrary secrets still need human review                                                                                                                               |
| Returned source / binary patch receipts                         | `patch`, `remote` tests using real Git and receiver processes                         | Exact digest approval, conflict/replay/recovery checks; no host index staging/reset                                                                                                                                                         |
| Persistent worker dashboard                                     | `worker-runtime`, `control`, real `test:herdr`                                        | Lifetime owner lease, busy IPC, exact opened pane ID and correlated queryable queued outcomes; dashboard is not an agent input target                                                                                                       |
| Foreground hints / prompt-wait / session continuation           | `test:herdr` against official 0.9.5                                                   | Real Herdr, synthetic TUI. Absolute reconnect metadata; no invented native session ID                                                                                                                                                       |
| Same remote agent across detach                                 | `test:guest-herdr`: stock native server/CLI with synthetic process; legacy tmux tests | New workers use native guest Herdr and real IDs; live Restart refuses replacement; server restore cannot auto-launch agents; unmarked records retain legacy tmux. Legacy authenticated persistence verified; fresh native lifecycle pending |
| Built-in/custom agent adapters                                  | `adapters`, `remote` tests                                                            | Codex 0.169.0, Claude 2.1.220, OpenCode 1.18.9 candidates; independent remote auth; no borrowed host login                                                                                                                                  |
| Public Compound installation                                    | Pinned installer and modern profile tests; opt-in `test:codex-bootstrap`              | Public native plugin only; account sync/owner login separate; no private host skill/profile copying                                                                                                                                         |
| Asynchronous create receipts                                    | `host-identity`, `provider` tests                                                     | Exact tags/cursor inventory; no action IDs; unknown or ambiguous match never repeats POST                                                                                                                                                   |
| Power-off/resume                                                | `lifecycle`, `connections` tests                                                      | Exact provider Stop after quiesce/checkpoint, fresh observed OFF; still billed; Start never sent to running/transitioning instance                                                                                                          |
| Snapshot hibernation/release                                    | `lifecycle` tests                                                                     | Exact operation description, `complete` status, size/OS/checkpoint gates and exact deletion approval; no image labels/action IDs                                                                                                            |
| Snapshot restore                                                | Fresh pin in `host-identity`; source/auth/service gates in `remote`                   | New instance/IP; same frozen plan/disk; no API architecture field; actual cloud-init clone/restore pending                                                                                                                                  |
| Unknown outcomes and recovery                                   | `lifecycle`, `worker-runtime`, `control` tests                                        | Receipt persisted before mutation; definitive rejections allow the next explicit retry, uncertain outcomes never replay; SSH deadlines bound hangs                                                                                          |
| Status/list/info                                                | `actions`, `mappings`, `lifecycle` tests                                              | No compute start; pending receipts, blocks and allocation/storage billing visible                                                                                                                                                           |
| Explicit Delete/Replace/Forget                                  | `lifecycle`, `mappings`, `worker-runtime` tests                                       | Exact-target approvals; mappings retained until confirmed deletion; snapshots/recovery metadata retained                                                                                                                                    |
| Production package                                              | `test:package`                                                                        | Production npm install and absolute entrypoint from unrelated cwd, no credentials or provider request                                                                                                                                       |
| Live observation entrypoint                                     | `test:live` requires exact worker/instance and opt-in                                 | Read-only provider observations plus pinned SSH checks on already-authorized existing worker; does not allocate or prove lifecycle                                                                                                          |
| Windows/macOS, shared VM tenants, blocks, reserved IP lifecycle | Unsupported                                                                           | Linux only; paths are not tenant isolation; block inventory blocks mutations                                                                                                                                                                |

An owner-authorized trial verified merged legacy-worker first boot/pinned SSH,
reviewed source upload/readback, independent Codex login, actual prompt/wait and
detach/reconnect, returned patch application and allocated power resume with
checkpoint/auth/conversation persistence. Separate native guest Herdr/Codex
proofs and actual helper process observations remain distinct from a complete
fresh-worker native lifecycle receipt. Snapshot release/restore requires its own
exact approvals and observations. Nothing in the synthetic suite substitutes for
those gates.

**Live provider Stop verification remains open.** Guest-only shutdown did not
establish provider OFF in the earlier live trial; separately authorized exact
`/halt` reconciliations were needed. Normal Stop/Hibernate now submit that exact
provider operation after application quiesce and a durable checkpoint, with
persisted intent/acknowledgement and no uncertain-outcome replay. Local fixtures
keep guest SSH acknowledgement separate from provider power. This correction
still needs its own authorized live trial; it does not establish full native
lifecycle or snapshot restore conformance. See
[the recorded verification limits](verification.md#live-provider-stop-gate).

Native guest runtime uses the pinned public 0.9.5 release, with architecture-specific
SHA256 verification before installation. `src/guest-herdr.mjs` is deployed into the
worker tools directory. It owns only that worker's durable Herdr state and explicit
socket. The native helper proof uses a Codex-shaped synthetic transport with an
explicit detection hint, and actual native prompt/wait and process observations;
it does not authenticate an account or establish live Vultr conformance.
