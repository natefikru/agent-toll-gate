import { describe, it, expect } from "vitest";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PaymentPayloadSchema } from "x402/types";
import { ViemWalletAdapter } from "../src/viem.js";
import type { PaymentRequirements } from "@tollgate/core";

// Anvil/Hardhat's published default test account #0 — publicly known,
// zero real funds, used purely for deterministic local signing. Never use
// this key for anything holding real value.
const THROWAWAY_PRIVATE_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// EIP-712 domain for real Base Sepolia USDC (chainId 84532). `extra` is
// required — without it, x402 can't determine the domain name/version and
// signs against the wrong domain (this is exactly the field Week 1's
// simplified PaymentRequirements type was dropping).
const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "50000",
  resource: "https://api.example.com/data",
  description: "test resource",
  mimeType: "application/json",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 60,
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // real Base Sepolia USDC
  extra: { name: "USDC", version: "2" },
};

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

describe("ViemWalletAdapter", () => {
  it("quote() echoes the requirements' amount/asset/network", async () => {
    const adapter = new ViemWalletAdapter(THROWAWAY_PRIVATE_KEY);
    await expect(adapter.quote(requirements)).resolves.toEqual({
      amount: "50000",
      asset: requirements.asset,
      network: "base-sepolia",
    });
  });

  it("authorize() produces a header that decodes into a valid x402 PaymentPayload", async () => {
    const adapter = new ViemWalletAdapter(THROWAWAY_PRIVATE_KEY);
    const signed = await adapter.authorize(requirements);

    expect(signed.txRef).toBeUndefined(); // not known until settlement — decoded from X-PAYMENT-RESPONSE later

    const decoded = JSON.parse(Buffer.from(signed.header, "base64").toString());
    const parsed = PaymentPayloadSchema.safeParse(decoded);
    expect(parsed.success).toBe(true);
  });

  it("authorize()'s signature recovers to this adapter's own account address — entirely offline, no RPC", async () => {
    const account = privateKeyToAccount(THROWAWAY_PRIVATE_KEY);
    const adapter = new ViemWalletAdapter(THROWAWAY_PRIVATE_KEY);
    const signed = await adapter.authorize(requirements);
    const decoded = JSON.parse(Buffer.from(signed.header, "base64").toString());
    const auth = decoded.payload.authorization;

    expect(auth.from).toBe(account.address);

    const recovered = await recoverTypedDataAddress({
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: requirements.asset as `0x${string}` },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: auth,
      signature: decoded.payload.signature,
    });

    expect(recovered).toBe(account.address);
  });
});
