# Linux Vultr implementation plan

Native execution in the supplied feature worktree. Seed:
`e6437d7b394f45b96fe63d9313163f2370df8b02`. Exact read-only source reference:
Hetzner `c5a3249f7538ecd9959c0222f95f2042af3e680c` (git archive; the supplied
checkout HEAD is different). No dependency checkout is modified.

1. Preserve attributed, tested source/patch/state/SSH/Herdr/adapter plumbing;
   characterize source and patch behavior before adaptation.
2. Replace provider contracts with Vultr v2 instance tags, cursor pagination,
   string IDs, base64 cloud-init, separate instance/power/server states,
   snapshots with exact operation descriptions, and account block inventory.
   Pin official govultr `8e5e0d2f21081aaea710efb2a4bd6c5a1eca7d28` and
   cloud-init 25.3 references before selecting methods.
3. Implement persisted operation receipts before submission; reconcile unknown
   outcomes by exact operation identity and observed state without replaying
   POST. Preserve worker identity across snapshot restore, issue a fresh host
   key before create, and verify checkpoint/source/auth before activation.
   Guest graceful shutdown is used rather than claiming force halt is graceful.
4. Provide Linux-only manifest, clean configuration example, ADR, capability
   matrix and opt-in synthetic/live observations. All live resources, account,
   credential retrieval and global plugin/config operations remain prohibited
   during implementation.
5. Run npm ci/check, actual official Herdr 0.9.5 in an isolated session, and
   production package install/absolute-entrypoint smoke. Preserve private logs
   outside Git. Simplify, obtain an independent actual code review, fix findings,
   commit/push and open a private PR. Never merge.

Evidence strategy: retained source/patch suite characterization (14 passing);
provider/lifecycle tests rewritten against actual Vultr wire contracts before
implementation, then full safety/SSH/dashboard/patch regressions. Mock and
synthetic runtime results never imply live Vultr or authenticated agent evidence.
