import type { PaymentRequirements } from "../src/types.js";

export function validPaymentRequirements(
  overrides: Partial<{ maxAmountRequired: string; payTo: string; asset: string; network: string }> = {},
): PaymentRequirements {
  return {
    scheme: "exact",
    network: overrides.network ?? "base-sepolia",
    maxAmountRequired: overrides.maxAmountRequired ?? "50000",
    resource: "https://api.example.com/data",
    description: "test resource",
    mimeType: "application/json",
    payTo: overrides.payTo ?? "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 60,
    asset: overrides.asset ?? "0x2222222222222222222222222222222222222222",
  };
}

export function validEnvelope(overrides: Parameters<typeof validPaymentRequirements>[0] = {}) {
  return {
    x402Version: 1,
    accepts: [validPaymentRequirements(overrides)],
  };
}
