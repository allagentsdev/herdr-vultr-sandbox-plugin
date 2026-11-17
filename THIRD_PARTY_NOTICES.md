# Third party notices

Provider-independent state, source/patch transfer, SSH, worker dashboard,
Herdr integration, adapters and tests are adapted from the MIT-licensed
[Herdr Hetzner Sandbox plugin](https://github.com/allagentsdev/herdr-hetzner-sandbox-plugin/tree/c5a3249f7538ecd9959c0222f95f2042af3e680c),
exact merged commit `c5a3249f7538ecd9959c0222f95f2042af3e680c` inspected on
2026-11-18. Its MIT notice is retained in LICENSE. Vultr provider lifecycle and
wire contracts replace Hetzner semantics; no provider conformance is inherited.

Source capture, patch review/apply and recovery, host state locking, context,
Herdr pane launching, process helpers and tests are adapted from the MIT-licensed
[Herdr Daytona Sandbox plugin](https://github.com/allagentsdev/herdr-daytona-sandbox-plugin),
inspected at Git commit `1444666283c5b2c1415c84cbdd7a96bc67e72826` on 2026-11-17. The retained LICENSE
includes its MIT notice, Copyright (c) 2026 Blaxel.

That plugin attributes its context, pane launcher, subprocess helper and path
filters to [Blaxel's plugin](https://github.com/blaxel-ai/herdr-blaxel-sandbox-plugin)
at `a6669e9fc367eba98bcff0aa5c972c4993e94def` (MIT, Copyright (c) 2026 Blaxel).

The Vercel plugin was inspected as a behavioral reference; no Vercel code or
provider/agent verification claims were copied. There is no provider SDK runtime
dependency. Development-tool licenses remain with their respective packages.
