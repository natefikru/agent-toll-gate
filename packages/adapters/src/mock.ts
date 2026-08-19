import type { WalletAdapter, PaymentRequirements, Quote, SignedPayload, Balance } from "@tollgate/core";

/**
 * Always authorizes, fakes a tx ref, no real chain interaction. Implements
 * the exact same WalletAdapter interface a real CDP or viem adapter would,
 * so swapping this out later is a pure drop-in with no interceptor changes.
 *
 * Pass { failAuthorize: true } to force authorize() to reject, so tests can
 * exercise the denied/disputed paths deterministically.
 */
export class MockWalletAdapter implements WalletAdapter {
  private counter = 0;

  constructor(private opts: { failAuthorize?: boolean } = {}) {}

  async quote(req: PaymentRequirements): Promise<Quote> {
    return { amount: req.price, asset: req.asset, network: req.network };
  }

  async authorize(req: PaymentRequirements): Promise<SignedPayload> {
    if (this.opts.failAuthorize) {
      throw new Error("mock wallet: authorize forced to fail");
    }
    this.counter += 1;
    return {
      payload: { mock: true, price: req.price, asset: req.asset, recipient: req.recipient },
      txRef: `mock-tx-${this.counter}`,
    };
  }

  async balance(): Promise<Balance> {
    return { asset: "USDC", amount: "1000000" };
  }
}
