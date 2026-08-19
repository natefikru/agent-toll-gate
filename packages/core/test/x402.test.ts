import { describe, it, expect } from "vitest";
import { parseX402, requirementsMatch } from "../src/x402.js";
import { validEnvelope, validPaymentRequirements } from "./fixtures.js";

describe("parseX402", () => {
  it("parses a valid envelope into the real x402 requirements shape", async () => {
    const res = new Response(JSON.stringify(validEnvelope()), { status: 402 });
    const requirements = await parseX402(res);
    expect(requirements).toEqual(validPaymentRequirements());
  });

  it("throws invalid_402_envelope on a schema mismatch", async () => {
    const res = new Response(JSON.stringify({ x402Version: 1, accepts: [{ nonsense: true }] }), { status: 402 });
    await expect(parseX402(res)).rejects.toMatchObject({ code: "invalid_402_envelope" });
  });

  it("throws invalid_402_envelope on non-JSON body", async () => {
    const res = new Response("not json", { status: 402 });
    await expect(parseX402(res)).rejects.toMatchObject({ code: "invalid_402_envelope" });
  });

  it("throws invalid_402_envelope when accepts is empty", async () => {
    const res = new Response(JSON.stringify({ x402Version: 1, accepts: [] }), { status: 402 });
    await expect(parseX402(res)).rejects.toMatchObject({ code: "invalid_402_envelope" });
  });
});

describe("requirementsMatch", () => {
  it("returns true for identical requirements", () => {
    const a = validPaymentRequirements();
    expect(requirementsMatch(a, validPaymentRequirements())).toBe(true);
  });

  it("returns false when the amount differs", () => {
    const a = validPaymentRequirements();
    expect(requirementsMatch(a, validPaymentRequirements({ maxAmountRequired: "99999" }))).toBe(false);
  });

  it("returns false when only the recipient (payTo) differs", () => {
    const a = validPaymentRequirements();
    expect(
      requirementsMatch(a, validPaymentRequirements({ payTo: "0x9999999999999999999999999999999999999999" })),
    ).toBe(false);
  });

  it("returns true when only metadata (description) differs — not economically significant", () => {
    const a = validPaymentRequirements();
    const b = { ...validPaymentRequirements(), description: "a different description" };
    expect(requirementsMatch(a, b)).toBe(true);
  });
});
