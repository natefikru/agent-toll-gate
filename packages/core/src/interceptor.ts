import { createHash } from "node:crypto";
import { parseX402, requirementsMatch } from "./x402.js";
import { Ledger, generateId } from "./ledger.js";
import { TollgateConfig, RequestContext, TollgateError, LedgerRow } from "./types.js";

export interface Tollgate {
  fetch(url: string, init?: RequestInit, ctx?: RequestContext): Promise<Response>;
  ledger: Ledger;
}

export function createTollgate(config: TollgateConfig): Tollgate {
  const ledger = new Ledger(config.dbPath);
  const wallet = config.wallet;

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

    const start = Date.now();
    const firstResponse = await fetch(url, init);

    if (firstResponse.status !== 402) {
      // Not a payment handshake — pass through untouched. Tollgate only
      // intercepts the payment flow, it is not a general error-handling layer.
      return firstResponse;
    }

    const requirements = await parseX402(firstResponse);

    // No policy engine yet (Week 2). Week 1 implicit-allows every request
    // that reaches this point.

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
        requirements,
        latencyMs: Date.now() - start,
      });
      throw new TollgateError("wallet_authorize_failed", "wallet failed to authorize payment", cause);
    }

    const paymentHeader = Buffer.from(JSON.stringify(signed.payload)).toString("base64");
    const retryResponse = await fetch(url, {
      ...init,
      headers: { ...init.headers, "X-PAYMENT": paymentHeader },
    });

    if (retryResponse.status === 402) {
      const retryRequirements = await parseX402(retryResponse.clone());
      if (!requirementsMatch(requirements, retryRequirements)) {
        recordRow(ledger, {
          ctx,
          url,
          requestHash,
          outcome: "disputed",
          requirements,
          txRef: signed.txRef,
          latencyMs: Date.now() - start,
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
        requirements,
        txRef: signed.txRef,
        latencyMs: Date.now() - start,
      });
      throw new TollgateError(
        "payment_disputed",
        `payment settled but the retry returned ${retryResponse.status}`,
      );
    }

    recordRow(ledger, {
      ctx,
      url,
      requestHash,
      outcome: "paid",
      requirements,
      txRef: signed.txRef,
      latencyMs: Date.now() - start,
    });
    return retryResponse;
  }

  return { fetch: tollgateFetch, ledger };
}

function recordRow(
  ledger: Ledger,
  opts: {
    ctx: RequestContext;
    url: string;
    requestHash: string;
    outcome: LedgerRow["outcome"];
    requirements: { price: string; asset: string; network: string };
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
    amount: opts.requirements.price,
    asset: opts.requirements.asset,
    network: opts.requirements.network,
    txRef: opts.txRef,
    requestHash: opts.requestHash,
    latencyMs: opts.latencyMs,
  });
}
