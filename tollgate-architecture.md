# Tollgate — Architecture & Design Doc

**A provider-neutral spend gateway for AI agents paying over x402.**

Self-hosted proxy that sits between an agent and every paid endpoint it calls. Enforces policy, deduplicates paid requests, records receipts, and answers the question no wallet answers today: *what did this job cost me, and why?*

Status: design doc / project spec. Written August 2026.

---

## 1. Why this exists

x402 solved *how* an agent pays. It did not solve how an operator stays sane once agents are spending.

The wallet layer (Cloudflare Wallets, AWS AgentCore Payments, Coinbase CDP, MetaMask ERC-7710 delegations, Openfort) enforces **caps**: max per transaction, total budget, merchant allowlists. That is necessary and it is being commoditized by very large companies. Do not compete there.

What the wallet layer does *not* do:

- Prevent the same resource being bought twice (retries, parallel agents, re-runs of the same job)
- Attribute spend to a task, agent, or user — a wallet sees a stream of payments, not a workload
- Compare prices across functionally equivalent endpoints
- Give an operator an audit trail keyed to *work done* rather than to transactions
- Survive a vendor swap — most of the above are single-vendor, several are still preview/waitlist

Tollgate is the client-side layer that does those things, on top of whichever wallet you use.

**Design principle:** the wallet decides *whether it is allowed to pay*. Tollgate decides *whether it needs to pay at all*, and records what happened.

---

## 2. Scope

**In scope**

1. Outbound HTTP interception of `402 Payment Required` responses
2. Policy evaluation before any payment is authorized
3. Content-addressed caching of paid responses
4. Payment execution via a pluggable wallet adapter
5. Receipt ledger + local dashboard
6. Price-aware routing across equivalent endpoints (v2)

**Out of scope**

- Custody. Tollgate never holds funds; it delegates signing to a wallet adapter.
- Being a facilitator. Verification and settlement stay with the facilitator the seller nominates.
- Seller-side paywalling. That is a separate, much smaller component (see §10).

---

## 3. System overview

```
┌─────────────┐
│  Agent /    │   ordinary HTTP or MCP tool call
│  MCP client │──────────────┐
└─────────────┘              │
                             ▼
                  ┌─────────────────────┐
                  │      TOLLGATE       │
                  │                     │
                  │  1 Interceptor      │
                  │  2 Cache            │
                  │  3 Policy Engine    │
                  │  4 Wallet Adapter   │
                  │  5 Ledger           │
                  └─────────────────────┘
                       │            │
              cache hit│            │cache miss + policy pass
                       │            ▼
                       │   ┌──────────────────┐
                       │   │  Paid endpoint   │
                       │   │  (402 → pay →    │
                       │   │   retry → 200)   │
                       │   └──────────────────┘
                       │            │
                       ▼            ▼
                  response returned to agent
                             │
                             ▼
                  ┌─────────────────────┐
                  │  Dashboard / API    │
                  │  spend by task,     │
                  │  agent, endpoint    │
                  └─────────────────────┘
```

---

## 4. Request lifecycle

The whole product is this loop. Everything else is supporting cast.

1. **Agent issues a request**
   - Either through the proxy (`HTTP_PROXY=localhost:7402`) or the SDK wrapper (`tollgate.fetch(...)`)
   - Optional headers carry context: `X-Tollgate-Task`, `X-Tollgate-Agent`
2. **Cache lookup**
   - Key = hash of (normalized URL + method + canonicalized body + relevant headers)
   - Hit and unexpired → return immediately, cost `$0`, log a `cache_hit` ledger row
   - This is the single biggest source of savings and the easiest thing to benchmark
3. **Forward request unpaid**
   - If the endpoint returns `200`, it was free. Pass through, optionally cache, done.
   - If it returns `402`, parse the payment requirements envelope: price, asset, network, recipient, facilitator
4. **Policy evaluation** (see §6)
   - Deny → return a structured error to the agent explaining *why*, so the agent can adapt rather than crash
   - Escalate → hold the request, fire the approval hook, block or fail-fast depending on config
   - Allow → continue
5. **Payment authorization**
   - Delegate to the wallet adapter, which signs the payment payload
   - Tollgate never sees a private key; it sees a signed payload and a resulting tx reference
6. **Retry with payment header**
   - On `200`, store the response in cache and write a `paid` row to the ledger with the tx hash
   - On failure after payment, flag a `disputed` row — this is a real failure mode and needs to be visible
7. **Return to agent**
   - The agent sees a normal response. The protocol is invisible above the call.

---

## 5. Components

### 5.1 Interceptor

Two entry modes, same core:

1. **Proxy mode** — a local HTTP proxy. Zero code change for the agent; works with any language or framework.
   - Requires MITM cert handling for HTTPS, or restrict to a configured set of hosts
2. **SDK mode** — a `fetch` / `httpx` wrapper. No cert games, more explicit, better ergonomics for context tagging.
3. **MCP mode** — Tollgate exposed as an MCP server that proxies calls to other paid MCP servers, so an agent gets policy and caching without knowing Tollgate exists.

Ship SDK mode first. Proxy mode is the demo-impressive one but the cert story eats a week.

### 5.2 Cache

- Content-addressed, pluggable store: in-memory → SQLite → Redis for a shared fleet cache
- Per-endpoint TTL policy, configurable, with `no-cache` respected
- **Negative caching**: remember that an endpoint returned a useless/empty result so a retry loop doesn't buy it again
- **Single-flight**: concurrent identical requests collapse into one payment, the rest wait on the result. Critical for swarms.
- Cache entries record what was paid for them, so the dashboard can show "saved $X via cache"

### 5.3 Policy Engine

Declarative, evaluated in order, first deny wins. Example config:

```yaml
wallet:
  adapter: cdp          # cdp | viem | cloudflare | mock
  network: base

defaults:
  max_per_call: 0.05        # USDC
  cache_ttl: 3600

budgets:
  per_task: 1.00
  daily: 25.00

endpoints:
  allow:
    - "api.example-data.com"
    - "*.trusted-scraper.io"
  deny:
    - "*"                   # default-deny is the sane posture

rules:
  - match: "api.expensive-llm.com/*"
    max_per_call: 0.50
    require_approval_above: 0.25
  - match: "*"
    on_first_seen: escalate  # never silently pay a brand-new counterparty
```

Rules to support at minimum:

- `max_per_call`, `per_task`, `daily`, `per_endpoint` budgets
- Domain allow/deny with globbing
- `require_approval_above` → webhook / push notification / CLI prompt
- `on_first_seen` → treat an unknown recipient as escalation-worthy
- `max_calls_per_task_per_endpoint` → the loop-protection rule that stops a stuck agent draining a budget one cent at a time

### 5.4 Wallet Adapter

A narrow interface, deliberately boring:

```ts
interface WalletAdapter {
  quote(req: PaymentRequirements): Promise<Quote>;
  authorize(req: PaymentRequirements): Promise<SignedPayload>;
  balance(): Promise<Balance>;
}
```

Implementations: `viem` local signer (dev/demo), Coinbase CDP Wallet API, Cloudflare Wallets when it becomes generally available, and a `mock` adapter for tests and for running the whole suite with no real funds.

This interface *is* the vendor-neutrality claim. Keep it small enough that a third implementation is an afternoon.

### 5.5 Ledger

Append-only table, SQLite by default:

| field | notes |
|---|---|
| `id` | ulid |
| `ts` | timestamp |
| `task_id` / `agent_id` | attribution — the whole point |
| `endpoint` | host + path pattern |
| `outcome` | `paid` \| `cache_hit` \| `denied` \| `escalated` \| `disputed` |
| `amount` / `asset` / `network` | what it cost |
| `tx_ref` | on-chain reference |
| `request_hash` | links to cache entry |
| `latency_ms` | payment overhead vs. resource time, split |

Everything in the dashboard is a query over this one table. Resist adding a second source of truth.

### 5.6 Dashboard

Small local web UI (or `tollgate report` in the CLI):

- Spend by task, by agent, by endpoint, over time
- Cache hit rate and dollars saved
- Escalations pending approval
- Receipt drill-down with tx links

This is the screenshot that sells the project. Budget real time for it.

---

## 6. Failure modes worth designing for

1. **Paid but didn't receive** — payment settles, endpoint 500s. Log `disputed`, expose in dashboard, optionally retry once with the same receipt if the seller supports idempotency.
2. **Runaway loop** — agent retries a failing paid call forever. Handled by `max_calls_per_task_per_endpoint` plus negative caching.
3. **Price manipulation** — a seller returns a higher price on the retry than in the original 402. Compare and abort on mismatch.
4. **Unknown counterparty** — `on_first_seen: escalate`, and record every new recipient address.
5. **Wallet unavailable** — fail closed with a clear structured error, never silently degrade to unpaid retries.
6. **Cache poisoning across tenants** — cache keys must include any auth-identity dimension, or a shared fleet cache leaks.

---

## 7. Tech stack

- **Language:** TypeScript (Node 22) — the x402 client libraries and MCP SDK are strongest here, and it keeps the SDK/proxy/MCP surfaces in one codebase
- **Storage:** SQLite (better-sqlite3) default, Redis optional for shared cache
- **Dashboard:** small React/Vite app served by the gateway, no separate deploy
- **Chain:** Base testnet for the whole test suite, mainnet USDC for the demo
- **Packaging:** `npx tollgate` for zero-install trial, Docker image for the proxy

---

## 8. Repo layout

```
tollgate/
├── packages/
│   ├── core/            # interceptor, policy, cache, ledger
│   ├── adapters/        # wallet adapters
│   ├── proxy/           # standalone HTTP proxy binary
│   ├── mcp/             # MCP-server front end
│   └── dashboard/       # local UI
├── examples/
│   ├── langchain-agent/
│   ├── claude-mcp/
│   └── swarm-dedup/     # the benchmark demo
├── bench/               # reproducible cost benchmark
├── docs/
│   ├── DESIGN.md        # this document
│   └── THREAT-MODEL.md
└── README.md
```

---

## 9. Build order

1. **Week 1 — core loop**
   - SDK-mode interceptor, 402 parse, mock wallet adapter, SQLite ledger
   - Test suite runs end-to-end with zero real money
2. **Week 2 — the differentiators**
   - Cache with single-flight and negative caching, policy engine, real wallet adapter on Base testnet
3. **Week 3 — visible surface**
   - Dashboard, `tollgate report` CLI, MCP front end
4. **Week 4 — proof**
   - Benchmark: run a realistic multi-agent research job with and without Tollgate, publish the cost delta
   - README, demo video, threat model doc

The benchmark in step 4 is the whole pitch. A number like "same workload, 41% less spend, full receipt trail" is worth more than any feature list.

---

## 10. The earning half (separate, deliberately small)

To demo both sides of the loop, run one paid endpoint of your own behind x402 — an edge worker with x402 middleware, one useful capability, priced in cents. Keep it small. Its job is to make the demo video complete, not to be the business. Something genuinely differentiated beats another markdown extractor, since that category is already served by Firecrawl, Jina Reader, and Tavily.

---

## 11. Positioning

- **What it is:** the FinOps and efficiency layer for agent spend, wallet-agnostic and self-hosted
- **What it is not:** a wallet, a facilitator, or a competitor to Cloudflare/AWS spend caps — it composes with them
- **Why now:** payment rails shipped in 2026 and the buyer-side tooling to operate them at scale did not
- **Realistic outcome:** strong open-source credibility asset and portfolio piece; direct revenue is a long shot at current protocol volumes, and the honest README should not pretend otherwise
