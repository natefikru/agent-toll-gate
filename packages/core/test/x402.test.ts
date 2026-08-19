import { describe, it, expect } from "vitest";
import { parseX402, requirementsMatch } from "../src/x402.js";
import { TollgateError } from "../src/types.js";

function validEnvelope(overrides: Partial<{ maxAmountRequired: string; payTo: string; asset: string; network: string }> = {}) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: overrides.network ?? "base-sepolia",
        maxAmountRequired: overrides.maxAmountRequired ?? "50000",
        resource: "https://api.example.com/data",
        description: "test resource",
        mimeType: "application/json",
        payTo: overrides.payTo ?? "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 60,
        asset: overrides.asset ?? "0x2222222222222222222222222222222222222222",
      },
    ],
  };
}

describe("parseX402", () => {
  it("parses a valid envelope into the simplified internal shape", async () => {
    const res = new Response(JSON.stringify(validEnvelope()), { status: 402 });
    const requirements = await parseX402(res);
    expect(requirements).toEqual({
      price: "50000",
      asset: "0x2222222222222222222222222222222222222222",
      network: "base-sepolia",
      recipient: "0x1111111111111111111111111111111111111111",
    });
  });

  it("throws invalid_402_envelope on a schema mismatch", async () => {
    const res = new Response(JSON.stringify({ x402Version: 1, accepts: [{ nonsense: true }] }), { status: 402 });
    await expect(parseX402(res)).rejects.toMatchObject<Partial<TollgateError>>({ code: "invalid_402_envelope" });
  });

  it("throws invalid_402_envelope on non-JSON body", async () => {
    const res = new Response("not json", { status: 402 });
    await expect(parseX402(res)).rejects.toMatchObject<Partial<TollgateError>>({ code: "invalid_402_envelope" });
  });

  it("throws invalid_402_envelope when accepts is empty", async () => {
    const res = new Response(JSON.stringify({ x402Version: 1, accepts: [] }), { status: 402 });
    await expect(parseX402(res)).rejects.toMatchObject<Partial<TollgateError>>({ code: "invalid_402_envelope" });
  });
});

describe("requirementsMatch", () => {
  it("returns true for identical requirements", () => {
    const a = { price: "1", asset: "USDC", network: "base", recipient: "0xabc" };
    expect(requirementsMatch(a, { ...a })).toBe(true);
  });

  it("returns false when the price differs", () => {
    const a = { price: "1", asset: "USDC", network: "base", recipient: "0xabc" };
    expect(requirementsMatch(a, { ...a, price: "2" })).toBe(false);
  });

  it("returns false when only the recipient differs (asset/recipient swap)", () => {
    const a = { price: "1", asset: "USDC", network: "base", recipient: "0xabc" };
    expect(requirementsMatch(a, { ...a, recipient: "0xdef" })).toBe(false);
  });
});
