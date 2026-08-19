import { x402ResponseSchema } from "x402/types";
import { PaymentRequirements, TollgateError } from "./types.js";

/**
 * Parses and validates a 402 response body against the real x402 envelope
 * schema and returns the accepted payment requirements as-is (no lossy
 * mapping — the real shape, including `extra`, is what a wallet adapter
 * needs to actually sign a payment).
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

  return accepted;
}

/**
 * Compares two requirements for the price-manipulation check (doc §6 #3):
 * a seller returning a higher price, different asset, network, or recipient
 * on the payment retry than in the original 402 must abort. Only the
 * economically significant fields are compared — resource/description/
 * mimeType are metadata, not something a price-manipulation check cares about.
 */
export function requirementsMatch(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.maxAmountRequired === b.maxAmountRequired &&
    a.asset === b.asset &&
    a.network === b.network &&
    a.payTo === b.payTo
  );
}
