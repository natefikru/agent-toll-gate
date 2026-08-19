/**
 * Simplified, vendor-neutral payment requirements. Mapped from the real x402
 * envelope in x402.ts so downstream code (WalletAdapter, Ledger) never has to
 * know about x402's on-chain-specific field names (payTo, maxAmountRequired).
 */
export interface PaymentRequirements {
  price: string; // decimal string, e.g. "0.05" — never a number, this is money
  asset: string; // e.g. "USDC"
  network: string; // e.g. "base-sepolia"
  recipient: string;
  facilitator?: string;
}

export interface Quote {
  amount: string;
  asset: string;
  network: string;
}

export interface SignedPayload {
  payload: unknown;
  txRef: string;
}

export interface Balance {
  asset: string;
  amount: string;
}

/**
 * Deliberately narrow so a third implementation is an afternoon of work.
 * Tollgate never sees a private key: it sees a signed payload and a tx ref.
 */
export interface WalletAdapter {
  quote(req: PaymentRequirements): Promise<Quote>;
  authorize(req: PaymentRequirements): Promise<SignedPayload>;
  balance(): Promise<Balance>;
}

// cache_hit is deferred to Week 2 — there is no cache yet.
export type LedgerOutcome = "paid" | "denied" | "escalated" | "disputed";

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
  txRef?: string;
  requestHash: string;
  latencyMs: number;
}

export interface TollgateConfig {
  wallet: WalletAdapter;
  dbPath?: string; // default ./tollgate.db
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
  | "price_mismatch";

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
