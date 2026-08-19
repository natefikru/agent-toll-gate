/**
 * The real x402 payment-requirements shape, re-exported as-is rather than
 * mapped onto a hand-rolled type. Week 1 stripped this down to
 * price/asset/network/recipient and it turned out to be lossy: real EIP-3009
 * signing needs resource/description/mimeType/maxTimeoutSeconds/extra too
 * (extra carries the EIP-712 domain for the asset contract). One real type,
 * no drift risk against the spec.
 */
export type { PaymentRequirements } from "x402/types";
import type { PaymentRequirements } from "x402/types";
import type { PolicyConfig } from "./policy.js";

export interface Quote {
  amount: string;
  asset: string;
  network: string;
}

/**
 * `header` is the ready-to-send X-PAYMENT value — only the wallet adapter
 * knows how to produce a spec-compliant encoding, so Tollgate never encodes
 * it itself. `txRef` is optional: x402's exact-EVM scheme is an offline
 * pre-signed authorization, so a real adapter doesn't know the settlement
 * tx hash at authorize-time — that only appears later via the seller's
 * X-PAYMENT-RESPONSE header. A mock adapter can supply one immediately.
 */
export interface SignedPayload {
  header: string;
  txRef?: string;
}

export interface Balance {
  asset: string;
  amount: string;
}

/**
 * Deliberately narrow so a third implementation is an afternoon of work.
 * Tollgate never sees a private key: it sees a signed header and (usually)
 * a tx ref.
 */
export interface WalletAdapter {
  quote(req: PaymentRequirements): Promise<Quote>;
  authorize(req: PaymentRequirements): Promise<SignedPayload>;
  balance(address?: string): Promise<Balance>;
}

// Spend-aggregation convention: only "paid" rows represent real money that
// left the wallet. "cache_hit" rows carry the original amount/asset/network
// purely to show what was saved — never sum them alongside "paid" rows.
export type LedgerOutcome = "paid" | "cache_hit" | "denied" | "escalated" | "disputed";

export interface LedgerRow {
  id: string;
  ts: number;
  taskId?: string;
  agentId?: string;
  endpoint: string;
  outcome: LedgerOutcome;
  amount?: string;
  asset?: string;
  network?: string;
  recipient?: string;
  txRef?: string;
  requestHash: string;
  latencyMs: number;
}

export interface TollgateConfig {
  wallet: WalletAdapter;
  dbPath?: string; // default ./tollgate.db
  cacheTtlMs?: number; // default 1 hour. One global TTL — per-endpoint override is policy-engine territory (future work).
  now?: () => number; // injectable clock for cache TTL and policy budget-window tests; defaults to Date.now
  policy?: PolicyConfig; // omitted = implicit allow everything (Week 1/2 behavior, unchanged)
}

export interface RequestContext {
  taskId?: string;
  agentId?: string;
}

export type TollgateErrorCode =
  | "invalid_402_envelope"
  | "unsupported_request_body"
  | "wallet_authorize_failed"
  | "payment_disputed"
  | "price_mismatch"
  | "policy_denied_domain"
  | "policy_denied_budget"
  | "policy_denied_max_calls"
  | "policy_denied_max_per_call"
  | "policy_escalation_denied";

export class TollgateError extends Error {
  constructor(
    public code: TollgateErrorCode,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "TollgateError";
  }
}
