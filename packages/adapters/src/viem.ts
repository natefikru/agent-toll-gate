import { createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createPaymentHeader } from "x402/client";
import { getUSDCBalance } from "x402/shared/evm";
import type { WalletAdapter, PaymentRequirements, Quote, SignedPayload, Balance } from "@tollgate/core";

const DEFAULT_BASE_SEPOLIA_RPC = "https://sepolia.base.org";

/**
 * Real wallet adapter: signs x402 payments with a local testnet private key
 * via viem, no hosted account/API keys needed. Chosen over CDP for the MVP
 * because a LocalAccount is a valid x402 EvmSigner on its own — the signing
 * step (authorize) is a pure offline EIP-3009 typed-data signature, no RPC
 * call, no gas. balance() is the one operation that touches a live chain.
 */
export class ViemWalletAdapter implements WalletAdapter {
  private account: ReturnType<typeof privateKeyToAccount>;
  private rpcUrl: string;

  constructor(privateKey: Hex, opts: { rpcUrl?: string } = {}) {
    this.account = privateKeyToAccount(privateKey);
    this.rpcUrl = opts.rpcUrl ?? DEFAULT_BASE_SEPOLIA_RPC;
  }

  async quote(req: PaymentRequirements): Promise<Quote> {
    return { amount: req.maxAmountRequired, asset: req.asset, network: req.network };
  }

  async authorize(req: PaymentRequirements): Promise<SignedPayload> {
    // x402Version isn't part of PaymentRequirements (it's an envelope-level
    // field) — version 1 is the current spec version used throughout this
    // codebase's test envelopes.
    const header = await createPaymentHeader(this.account, 1, req);
    // The settlement tx hash isn't known yet — exact-EVM is an offline
    // pre-signed authorization. The interceptor decodes the real hash from
    // the seller's X-PAYMENT-RESPONSE header once payment actually settles.
    return { header };
  }

  async balance(address?: string): Promise<Balance> {
    const target = (address ?? this.account.address) as Address;
    const client = createPublicClient({ chain: baseSepolia, transport: http(this.rpcUrl) });
    const amount = await getUSDCBalance(client, target);
    return { asset: "USDC", amount: amount.toString() };
  }
}
