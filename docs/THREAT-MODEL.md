# Tollgate — Threat Model

This documents what Tollgate actually protects against today, what it deliberately doesn't, and where the gaps are — as built, not as aspired to. It's written from the implementation, not derived from the design doc in the abstract; every claim here traces to real code in this repo. Where something is a known, accepted limitation rather than a bug, it's called out as such — several of these are already documented as scope decisions in the commit history and code comments, collected here in one place.

See [`tollgate-architecture.md`](../tollgate-architecture.md) for the full design rationale and §6 for the failure modes this was originally scoped against.

## What Tollgate is not

Tollgate never holds funds. It delegates signing to a `WalletAdapter` (`packages/core/src/types.ts`) and never sees a private key — it sees a signed payment header and, eventually, a settlement transaction hash. This is the load-bearing custody boundary: nothing described below is a fund-loss risk in the sense of Tollgate itself being compromised and draining a wallet, because Tollgate structurally cannot initiate a payment without the wallet adapter's cooperation.

It is also not a facilitator. Payment verification and settlement are the facilitator's job (a third party the seller nominates); Tollgate and the seller both just talk to it over HTTP. `ViemWalletAdapter` (`packages/adapters/src/viem.ts`) produces an offline signature and nothing more — it never submits a transaction or spends gas.

## Trust boundaries

| Boundary | What crosses it | Trust assumption |
|---|---|---|
| Tollgate ↔ `WalletAdapter` | `PaymentRequirements` in, `{header, txRef?}` out | The adapter signs faithfully and doesn't leak the key. Tollgate has no way to detect a malicious adapter signing something other than what it was asked to sign. |
| Tollgate ↔ seller (HTTP) | The unpaid request, the `402` envelope, the retry with `X-PAYMENT`, the response | The seller's `402` envelope is schema-validated (`packages/core/src/x402.ts`, against the real `x402` package's Zod schema) before anything acts on it. The seller could still return a *valid but different* envelope on retry — see "price manipulation" below. |
| Wallet adapter ↔ facilitator (indirect, via the seller) | The signed payment payload | Tollgate has no visibility into this exchange at all. It only sees the seller's final HTTP response. |
| `onEscalate` callback ↔ Tollgate | An `EscalationContext`, a `boolean` | Caller-owned. Tollgate imposes no timeout and no sandboxing — see "escalation" below. |

## Failure modes and current handling

Each of these corresponds to a failure mode named in the architecture doc §6.

**Paid but didn't receive (seller 500s after settlement).** Handled: the interceptor writes a `disputed` ledger row rather than silently succeeding or silently retrying (`packages/core/src/interceptor.ts`). Not handled: no automatic retry-with-same-receipt even when a seller supports idempotency — every `disputed` outcome requires manual/application-level follow-up today.

**Runaway loop (agent retries a failing paid call forever).** Handled two ways: `maxCallsPerTaskPerEndpoint` in the policy engine caps repeated real payments to the same (task, endpoint) pair, and the cache means an agent re-requesting an *already-succeeded* call pays nothing after the first time. Not handled: the cap requires the caller to actually configure `maxCallsPerTaskPerEndpoint` — there's no default limit, so an unconfigured Tollgate instance will let a loop drain a budget one call at a time, bounded only by whatever budget rules *are* configured.

**Price manipulation (seller returns different terms on the paid retry than the original `402`).** Handled: `requirementsMatch` (`packages/core/src/x402.ts`) compares the economically significant fields — amount, asset, network, recipient — between the initial and retry envelopes, and aborts with a `disputed` row on any mismatch, before ever treating the call as paid.

**Unknown counterparty.** Handled, opt-in: `onFirstSeenEscalate` escalates the first payment to any recipient the ledger has never actually paid before (`Ledger.hasEverPaid`, filtered to `outcome = 'paid'` specifically — a prior denial or dispute for the same recipient does not count as "seen"). Off by default: turning this on by default would make every fresh ledger's first payment escalate, which is correct security posture but was judged too surprising a default for this stage — see the policy engine's scope decisions in `docs`/commit history.

**Wallet unavailable.** Handled: `wallet.authorize()` failures — both a rejected promise and a synchronous throw — are treated identically and fail closed. Tollgate never degrades to an unpaid retry. Same fail-closed treatment applies to a throwing/rejecting `onEscalate` callback.

**Cache poisoning across tenants.** Not applicable yet, and not handled: cache keys are `sha256(method + url + body)` only (`packages/core/src/interceptor.ts`). There is no multi-tenant auth-identity concept anywhere in this codebase yet, so there's nothing to key the cache by beyond the request shape. If Tollgate ever serves multiple distinct identities from one process, this becomes a real gap — a cached response paid for by tenant A could be served to tenant B for free. Flagged here explicitly because it will not announce itself as a bug when it happens; it will just look like the cache working correctly for the wrong audience.

## Known limitations (accepted, not oversights)

These are all things a determined attacker or an unlucky race condition could exploit today. None of them threaten fund custody (see "What Tollgate is not" above) — the exposure in every case is a soft accounting or availability guarantee being weaker than it might appear, not money leaving a wallet.

- **Budget and loop-protection checks are not atomic under concurrency.** `perTaskBudget`, `dailyBudget`, and `maxCallsPerTaskPerEndpoint` read the ledger, decide, and only later record the outcome. Single-flight dedup closes this for *identical* concurrent requests (same URL/method/body), but two *distinct* concurrent calls sharing a task or a day can both read a pre-payment total and both pass a check that should only have admitted one. Closing this fully needs reserved/provisional ledger rows and locking — deliberately not built yet (`packages/core/src/policy.ts`, `packages/core/src/interceptor.ts`).
- **Single-flight and the in-flight-request map are per-process only.** A fleet of Tollgate instances behind the same wallet has no cross-process dedup — N processes each hitting the same URL at once will each pay once. The doc's cross-fleet dedup via a shared store (Redis) is explicitly future work.
- **The cache has no eviction.** Expired entries are filtered on read, never deleted. A long-running process accumulates stale rows in the `cache` table indefinitely.
- **No timeout on `onEscalate`.** A callback that never resolves hangs that request indefinitely. This is caller-owned by design — Tollgate doesn't sandbox or bound it — but it means a misbehaving approval integration is a real availability risk to whatever called `tollgate.fetch`.
- **No migration path for schema changes to an existing `tollgate.db`.** The `recipient` column (added for the policy engine's first-seen check) will throw "no such column" against a database file created before it existed. The fix today is deleting the local file and letting it recreate — acceptable at this project's current stage (no deployed instance), a real problem the moment one exists.
- **The ledger doesn't persist *why* a decision was made.** A `denied` or `escalated` row records the outcome and the amount, but the specific rule or budget that triggered it only exists in the `TollgateError` thrown at call time — it's visible to the caller in the moment, not to someone auditing the ledger later. Similarly, an approved escalation that goes on to pay is indistinguishable in the ledger from an ordinary payment.
- **No rate limiting or backoff on the outbound `fetch` calls.** A misconfigured policy (or none at all) plus a hostile/broken seller could turn Tollgate into an unintentional participant in a request flood — there is currently nothing here that would stop it, beyond whatever `maxCallsPerTaskPerEndpoint` the caller opted into.
- **The mock wallet adapter's signing is not spec-compliant** — it's a fake blob, not a real x402 encoding. This is intentional (it's a test double), but it means the entire default test suite exercises the interceptor's *logic* without ever exercising real cryptographic correctness. That's what `packages/adapters/test/viem.test.ts` and the opt-in live test (`packages/adapters/test/live-real-seller.test.ts`) are for — real signing is tested, just not by default.

## Where to look for more

- `packages/core/src/interceptor.ts` — the actual request lifecycle and every fail-closed decision point.
- `packages/core/src/policy.ts` — rule evaluation order (hard caps before escalation, deliberately, after a real ordering bug was caught in review before shipping).
- `tollgate-architecture.md` §6 — the original failure-mode list this document tracks against.
