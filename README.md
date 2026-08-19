# Agent Toll Gate

A provider-neutral spend gateway for AI agents paying over [x402](https://x402.org). Agent Toll Gate sits between your agent and every paid endpoint it calls: it caches, dedupes, enforces policy, pays through a pluggable wallet adapter, and records a receipt for everything.

> The wallet decides *whether it is allowed to pay*. Agent Toll Gate decides *whether it needs to pay at all*, and records what happened.

The code, package names, and CLI command are still called **Tollgate**/`tollgate` throughout — that's the project's original working name and its API surface, unchanged by this rename. "Agent Toll Gate" is the project's name; `createTollgate`, `@tollgate/core`, and the `tollgate` command are what you'll actually type.

Full design rationale, scope, and build order: [`tollgate-architecture.md`](./tollgate-architecture.md). Security posture and known gaps: [`docs/THREAT-MODEL.md`](./docs/THREAT-MODEL.md).

**Status:** early, working MVP. The core payment loop, caching, policy engine, and a CLI reporter are built and tested — including one end-to-end run against a real seller, a real facilitator, and real testnet USDC on Base Sepolia. The dashboard, proxy mode, and MCP mode are not built yet. See [What's built / what's not](#whats-built--whats-not) below.

## Quickstart

Requires Node ≥ 22.

```bash
npm install
npm run build
npm test
```

That runs the full test suite (100+ tests) against real local HTTP servers with a mock wallet — no network access, no real money, deterministic.

## How it works

```ts
import { createTollgate } from "@tollgate/core";
import { MockWalletAdapter } from "@tollgate/adapters";

const tollgate = createTollgate({
  wallet: new MockWalletAdapter(),
  dbPath: "./tollgate.db",
});

const response = await tollgate.fetch("https://api.example.com/paid-resource", {}, {
  taskId: "research-job-42",
  agentId: "scraper-agent",
});
```

`tollgate.fetch` behaves like `fetch`, but:

1. Checks a local SQLite cache first — an identical prior payment is replayed for free.
2. Collapses concurrent identical calls into one payment (single-flight) — a swarm of agents hitting the same URL at once only pays once.
3. Runs your policy config (domain rules, budgets, loop protection, escalation) before authorizing anything.
4. On a real `402`, authorizes payment through your `WalletAdapter`, retries with the signed payment header, and returns the paid response.
5. Records every outcome — `paid`, `cache_hit`, `denied`, `escalated`, or `disputed` — to the ledger, with the amount, asset, network, recipient, and transaction reference.

### Wallet adapters

Two implementations ship today, both behind the same narrow interface (`quote` / `authorize` / `balance`) so a third is an afternoon of work:

- **`MockWalletAdapter`** — fakes everything, no chain interaction. What the entire default test suite runs against.
- **`ViemWalletAdapter`** — signs real x402 payments offline with a local testnet private key (EIP-3009 typed-data signing, no RPC call, no gas). The one operation that touches a live chain is `balance()`.

```ts
import { ViemWalletAdapter } from "@tollgate/adapters";

const wallet = new ViemWalletAdapter(process.env.TOLLGATE_TESTNET_PRIVATE_KEY);
```

### Policy engine

```ts
const tollgate = createTollgate({
  wallet,
  dbPath: "./tollgate.db",
  policy: {
    rules: [
      { match: "*.trusted-scraper.io", action: "allow" },
      { match: "*", action: "deny" }, // default-deny — opt into this explicitly, it isn't forced
    ],
    maxPerCall: "500000",       // base-unit integer string, e.g. 0.5 USDC
    perTaskBudget: "1000000",
    dailyBudget: "25000000",
    maxCallsPerTaskPerEndpoint: 5,
    onFirstSeenEscalate: true,
    onEscalate: async (ctx) => {
      // ctx.reason, ctx.amount, ctx.recipient, ... — wire this to a webhook,
      // a push notification, or a CLI prompt. Return true to approve.
      return await askSomeoneForApproval(ctx);
    },
  },
});
```

Domain rules run before any network call. Hard caps (`maxPerCall`, budgets, loop protection) are checked before escalation, so an approved escalation can never bypass a budget. No `policy` config at all means implicit-allow-everything, same as the earliest version of this project. See [`packages/core/src/policy.ts`](./packages/core/src/policy.ts) for the full rule evaluation order and [`docs/THREAT-MODEL.md`](./docs/THREAT-MODEL.md) for what this does and doesn't guarantee under concurrency.

### Reporting

```bash
npm run tollgate -- report --db ./tollgate.db
npm run tollgate -- report --db ./tollgate.db --json
npm run tollgate -- report --db ./tollgate.db --task research-job-42 --since 2026-08-01T00:00:00Z
```

Spend by asset/network/task/agent/endpoint, cache-hit savings, and history sections for recent receipts, escalations, denials, and disputes — read directly from the ledger, no server, no dependency beyond Node itself.

## Testing against real infrastructure

Everything above runs fully offline by default. There's also one **opt-in, real-money(-testnet) integration test** that pays a real seller through the public [x402.org](https://x402.org) facilitator on Base Sepolia and settles a real on-chain transaction:

```bash
npm run test:live
```

It's skipped unless `TOLLGATE_LIVE_TESTNET=1` and a funded `TOLLGATE_TESTNET_PRIVATE_KEY` are set (see `.env.example`), so it never runs in CI or a normal `npm test`. It's also rerunnable indefinitely without new faucet funds — each payment only needs a fresh signature nonce, not fresh money.

To fund a fresh testnet wallet: generate a key, get its address funded via [faucet.circle.com](https://faucet.circle.com) (Base Sepolia), and put the key in `.env`. `scripts/fund-testnet-wallet.mjs` automates the Circle faucet API path if you have API access with mainnet account verification (`Circle's programmatic /v1/faucet/drips endpoint requires it`); the web faucet needs neither.

## Repo layout

```
packages/
├── core/         # interceptor, x402 parsing, cache, policy engine, ledger — the whole product
├── adapters/      # wallet adapters (mock, viem)
├── cli/            # tollgate report
├── proxy/           # not implemented — placeholder for HTTP proxy mode
├── mcp/              # not implemented — placeholder for an MCP-server front end
└── dashboard/         # not implemented — placeholder for a local spend dashboard
```

## What's built / what's not

**Built:** SDK-mode interceptor, real x402 payment loop, content-addressed cache with single-flight dedup, one real wallet adapter (viem, testnet-verified against real infrastructure), a policy engine (domain rules, budgets, loop protection, escalation), and the `tollgate report` CLI.

**Not built:** the dashboard, proxy mode (`HTTP_PROXY=...`, needs MITM cert handling), MCP mode, a CDP/Cloudflare Wallets adapter, cross-fleet cache/single-flight (Redis), a benchmark/demo video, and the small self-hosted paid endpoint described in the architecture doc's §10. See the architecture doc's build order (§9) for the intended sequencing.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Compiles all packages |
| `npm test` | Full offline test suite |
| `npm run typecheck` | Typechecks every package's source *and* test files |
| `npm run tollgate -- report [flags]` | Runs the CLI reporter (requires `npm run build` first) |
| `npm run test:live` | Opt-in live-network integration test (see above) |
