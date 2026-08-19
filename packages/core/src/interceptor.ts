import { createHash } from "node:crypto";
import { decodeXPaymentResponse } from "x402/shared";
import { parseX402, requirementsMatch } from "./x402.js";
import { Ledger, generateId } from "./ledger.js";
import { SqliteCacheStore, responseFromCacheEntry, cacheEntryFromResponse } from "./cache.js";
import { evaluateDomainPolicy, evaluateMoneyPolicy } from "./policy.js";
import { TollgateConfig, RequestContext, TollgateError, LedgerRow } from "./types.js";

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

export interface Tollgate {
  fetch(url: string, init?: RequestInit, ctx?: RequestContext): Promise<Response>;
  ledger: Ledger;
}

function isNoCache(init: RequestInit): boolean {
  return new Headers(init.headers).get("cache-control") === "no-cache";
}

export function createTollgate(config: TollgateConfig): Tollgate {
  const ledger = new Ledger(config.dbPath);
  const cache = new SqliteCacheStore(ledger.database, config.now);
  const wallet = config.wallet;
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = config.now ?? Date.now;

  // Per-process only — the doc's cross-fleet dedup via Redis is future work.
  const inFlight = new Map<string, Promise<Response>>();

  async function runLifecycle(
    url: string,
    init: RequestInit,
    ctx: RequestContext,
    requestHash: string,
    noCache: boolean,
  ): Promise<Response> {
    // Domain rules need no payment data, so they run before any network call
    // — including before the cache lookup, so a domain deny always overrides
    // a stale cache entry rather than being a silent end-run around it.
    const domainDecision = evaluateDomainPolicy(config.policy, url);
    if (domainDecision.type === "deny") {
      recordRow(ledger, { ctx, url, requestHash, outcome: "denied", latencyMs: 0 });
      throw new TollgateError(domainDecision.code, domainDecision.reason);
    }

    if (!noCache) {
      const cached = await cache.get(requestHash);
      if (cached) {
        recordRow(ledger, {
          ctx,
          url,
          requestHash,
          outcome: "cache_hit",
          amount: cached.amount,
          asset: cached.asset,
          network: cached.network,
          txRef: cached.txRef,
          latencyMs: 0,
        });
        return responseFromCacheEntry(cached);
      }
    }

    const start = now();
    const firstResponse = await fetch(url, init);

    if (firstResponse.status !== 402) {
      // Not a payment handshake — pass through untouched. Tollgate only
      // intercepts the payment flow, it is not a general error-handling layer.
      return firstResponse;
    }

    const requirements = await parseX402(firstResponse);

    const moneyDecision = evaluateMoneyPolicy(config.policy, ledger, { url, requirements, ctx, now });
    if (moneyDecision.type === "deny") {
      recordRow(ledger, {
        ctx,
        url,
        requestHash,
        outcome: "denied",
        amount: requirements.maxAmountRequired,
        asset: requirements.asset,
        network: requirements.network,
        recipient: requirements.payTo,
        latencyMs: now() - start,
      });
      throw new TollgateError(moneyDecision.code, moneyDecision.reason);
    }
    if (moneyDecision.type === "escalate") {
      const approved = config.policy?.onEscalate
        ? await config.policy.onEscalate({
            reason: moneyDecision.reason,
            url,
            taskId: ctx.taskId,
            agentId: ctx.agentId,
            amount: requirements.maxAmountRequired,
            asset: requirements.asset,
            network: requirements.network,
            recipient: requirements.payTo,
          }).catch(() => false) // fail closed — a throwing/rejecting callback is treated as a denial
        : false; // no callback configured — fail-fast deny, per doc §5.3
      if (!approved) {
        recordRow(ledger, {
          ctx,
          url,
          requestHash,
          outcome: "escalated",
          amount: requirements.maxAmountRequired,
          asset: requirements.asset,
          network: requirements.network,
          recipient: requirements.payTo,
          latencyMs: now() - start,
        });
        throw new TollgateError("policy_escalation_denied", `escalation (${moneyDecision.reason}) was not approved`);
      }
      // approved — fall through to wallet.authorize below, same as an "allow" decision
    }

    let signed;
    try {
      signed = await wallet.authorize(requirements);
    } catch (cause) {
      // Fail closed on both a rejected promise and a synchronous throw —
      // never silently degrade to an unpaid retry (doc §6 #5).
      recordRow(ledger, {
        ctx,
        url,
        requestHash,
        outcome: "denied",
        amount: requirements.maxAmountRequired,
        asset: requirements.asset,
        network: requirements.network,
        recipient: requirements.payTo,
        latencyMs: now() - start,
      });
      throw new TollgateError("wallet_authorize_failed", "wallet failed to authorize payment", cause);
    }

    const retryHeaders = new Headers(init.headers);
    retryHeaders.set("X-PAYMENT", signed.header);
    const retryResponse = await fetch(url, { ...init, headers: retryHeaders });

    if (retryResponse.status === 402) {
      const retryRequirements = await parseX402(retryResponse.clone());
      if (!requirementsMatch(requirements, retryRequirements)) {
        recordRow(ledger, {
          ctx,
          url,
          requestHash,
          outcome: "disputed",
          amount: requirements.maxAmountRequired,
          asset: requirements.asset,
          network: requirements.network,
          recipient: requirements.payTo,
          txRef: signed.txRef,
          latencyMs: now() - start,
        });
        throw new TollgateError(
          "price_mismatch",
          "seller changed payment requirements between the initial 402 and the paid retry",
        );
      }
    }

    if (retryResponse.status !== 200) {
      recordRow(ledger, {
        ctx,
        url,
        requestHash,
        outcome: "disputed",
        amount: requirements.maxAmountRequired,
        asset: requirements.asset,
        network: requirements.network,
        recipient: requirements.payTo,
        txRef: signed.txRef,
        latencyMs: now() - start,
      });
      throw new TollgateError(
        "payment_disputed",
        `payment settled but the retry returned ${retryResponse.status}`,
      );
    }

    const txRef = decodeSettlementTxRef(retryResponse) ?? signed.txRef;

    if (!noCache) {
      const cacheable = retryResponse.clone();
      const entry = await cacheEntryFromResponse(cacheable, {
        amount: requirements.maxAmountRequired,
        asset: requirements.asset,
        network: requirements.network,
        txRef,
        ttlMs: cacheTtlMs,
        now,
      });
      await cache.set(requestHash, entry);
    }

    recordRow(ledger, {
      ctx,
      url,
      requestHash,
      outcome: "paid",
      amount: requirements.maxAmountRequired,
      asset: requirements.asset,
      network: requirements.network,
      recipient: requirements.payTo,
      txRef,
      latencyMs: now() - start,
    });
    return retryResponse;
  }

  async function tollgateFetch(url: string, init: RequestInit = {}, ctx: RequestContext = {}): Promise<Response> {
    const method = init.method ?? "GET";

    // Week 1 only supports string bodies (or none) — streamed/FormData bodies
    // are out of scope; buffering once here keeps the same body usable for
    // both the initial unpaid attempt and the paid retry.
    if (init.body !== undefined && typeof init.body !== "string") {
      throw new TollgateError("unsupported_request_body", "Tollgate MVP only supports string request bodies");
    }
    const body = init.body as string | undefined;
    const requestHash = createHash("sha256").update(`${method}:${url}:${body ?? ""}`).digest("hex");
    const noCache = isNoCache(init);

    // no-cache bypasses both the cache AND single-flight dedup — always runs
    // its own independent lifecycle.
    if (noCache) {
      return runLifecycle(url, init, ctx, requestHash, true);
    }

    // Single-flight: the map check-and-install must be the very first
    // synchronous operation for a given hash — cache lookup happens *inside*
    // the guarded promise, not before it. Checking the map after an `await`
    // (e.g. after the cache lookup) leaves a race window where two
    // concurrent callers both see a miss before either installs anything.
    const existing = inFlight.get(requestHash);
    if (existing) return existing;

    const promise = runLifecycle(url, init, ctx, requestHash, false).finally(() => {
      inFlight.delete(requestHash);
    });
    inFlight.set(requestHash, promise);
    return promise;
  }

  return { fetch: tollgateFetch, ledger };
}

function decodeSettlementTxRef(res: Response): string | undefined {
  const header = res.headers.get("X-PAYMENT-RESPONSE");
  if (!header) return undefined;
  try {
    return decodeXPaymentResponse(header).transaction;
  } catch {
    // Malformed header — fall back to the wallet's own txRef rather than
    // failing an otherwise-successful paid request.
    return undefined;
  }
}

function recordRow(
  ledger: Ledger,
  opts: {
    ctx: RequestContext;
    url: string;
    requestHash: string;
    outcome: LedgerRow["outcome"];
    amount?: string;
    asset?: string;
    network?: string;
    recipient?: string;
    txRef?: string;
    latencyMs: number;
  },
): void {
  ledger.insert({
    id: generateId(),
    ts: Date.now(),
    taskId: opts.ctx.taskId,
    agentId: opts.ctx.agentId,
    endpoint: opts.url,
    outcome: opts.outcome,
    amount: opts.amount,
    asset: opts.asset,
    network: opts.network,
    recipient: opts.recipient,
    txRef: opts.txRef,
    requestHash: opts.requestHash,
    latencyMs: opts.latencyMs,
  });
}
