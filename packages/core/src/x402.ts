import { x402ResponseSchema, type PaymentRequirements as X402PaymentRequirements } from "x402/types";
import { PaymentRequirements, TollgateError } from "./types.js";

/**
 * Parses and validates a 402 response body against the real x402 envelope
 * schema, then maps it onto Tollgate's simplified internal shape so the
 * rest of the codebase (WalletAdapter, Ledger) stays protocol-detail-free.
 *
 * A 402 body can offer multiple accepted payment options (`accepts`). Week 1
 * just takes the first one — picking the cheapest/best option across schemes
 * is policy-engine territory (Week 2+).
 */
export async function parseX402(res: Response): Promise<PaymentRequirements> {
  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new TollgateError("invalid_402_envelope", "402 response body was not valid JSON", cause);
  }

  const result = x402ResponseSchema.safeParse(body);
  if (!result.success) {
    throw new TollgateError("invalid_402_envelope", `402 body failed x402 schema validation: ${result.error.message}`, result.error);
  }

  const accepted = result.data.accepts?.[0];
  if (!accepted) {
    throw new TollgateError("invalid_402_envelope", "402 response listed no accepted payment requirements");
  }

  return toInternal(accepted);
}

function toInternal(req: X402PaymentRequirements): PaymentRequirements {
  return {
    price: req.maxAmountRequired,
    asset: req.asset,
    network: req.network,
    recipient: req.payTo,
  };
}

/**
 * Compares two requirements for the price-manipulation check (doc §6 #3):
 * a seller returning a higher price, different asset, or different
 * recipient on the payment retry than in the original 402 must abort.
 */
export function requirementsMatch(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return a.price === b.price && a.asset === b.asset && a.network === b.network && a.recipient === b.recipient;
}
