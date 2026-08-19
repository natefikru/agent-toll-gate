import type { WalletAdapter, PaymentRequirements, Quote, SignedPayload, Balance } from "@tollgate/core";

/**
 * Always authorizes, fakes a header and tx ref, no real chain interaction.
 * Implements the exact same WalletAdapter interface a real viem or CDP
 * adapter would, so swapping this out later is a pure drop-in with no
 * interceptor changes. Never emits an X-PAYMENT-RESPONSE header (nothing
 * about that is wallet-side), so the interceptor's txRef fallback to
 * signed.txRef is exercised naturally whenever this mock is used.
 *
 * Pass { failAuthorize: true } to force authorize() to reject, so tests can
 * exercise the denied/disputed paths deterministically.
 */
export class MockWalletAdapter implements WalletAdapter {
  private counter = 0;

  constructor(private opts: { failAuthorize?: boolean } = {}) {}

  async quote(req: PaymentRequirements): Promise<Quote> {
    return { amount: req.maxAmountRequired, asset: req.asset, network: req.network };
  }

  async authorize(req: PaymentRequirements): Promise<SignedPayload> {
    if (this.opts.failAuthorize) {
      throw new Error("mock wallet: authorize forced to fail");
    }
    this.counter += 1;
    const fakeHeader = Buffer.from(
      JSON.stringify({ mock: true, maxAmountRequired: req.maxAmountRequired, asset: req.asset, payTo: req.payTo }),
    ).toString("base64");
    return { header: fakeHeader, txRef: `mock-tx-${this.counter}` };
  }

  async balance(): Promise<Balance> {
    return { asset: "USDC", amount: "1000000" };
  }
}
