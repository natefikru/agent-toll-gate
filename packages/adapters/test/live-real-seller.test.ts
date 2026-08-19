import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http as viemHttp } from "viem";
import { baseSepolia } from "viem/chains";
import { useFacilitator } from "x402/verify";
import { getUSDCBalance } from "x402/shared/evm";
// Relative src import, not "@tollgate/core" — matches interceptor.test.ts's
// pattern of reaching into another package's src directly, so this runs
// against source without requiring a prior `npm run build`.
import { createTollgate } from "../../core/src/interceptor.js";
import { ViemWalletAdapter } from "../src/viem.js";

/**
 * Live-network integration test — spends a small amount of REAL testnet
 * USDC via the public x402.org facilitator on Base Sepolia. Skipped unless
 * explicitly opted into (TOLLGATE_LIVE_TESTNET=1) with a funded wallet, so
 * it never runs in normal `npm test` or CI. Each run costs 0.01 USDC and
 * consumes no faucet allowance — EIP-3009 authorizations only need a fresh
 * nonce, not fresh funds, so the same funded wallet covers ~thousands of
 * reruns. Run with: `npm run test:live` (loads .env, requires
 * TOLLGATE_TESTNET_PRIVATE_KEY and TOLLGATE_SELLER_PRIVATE_KEY funded on
 * Base Sepolia).
 */

// vitest doesn't load .env itself — read it directly so this test works
// however vitest is invoked, without adding a dotenv dependency.
function loadDotEnv(): void {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
}
loadDotEnv();

const buyerKey = process.env.TOLLGATE_TESTNET_PRIVATE_KEY as `0x${string}` | undefined;
const sellerKey = process.env.TOLLGATE_SELLER_PRIVATE_KEY as `0x${string}` | undefined;
const shouldRun = process.env.TOLLGATE_LIVE_TESTNET === "1" && !!buyerKey && !!sellerKey;

const USDC_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // real Base Sepolia USDC
const PRICE = "10000"; // 0.01 USDC (6 decimals)

describe.skipIf(!shouldRun)("live: real seller on Base Sepolia via x402.org facilitator", () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  let dbPath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tollgate-live-"));
    dbPath = join(dir, "tollgate.db");

    const seller = privateKeyToAccount(sellerKey!);
    const facilitator = useFacilitator({ url: "https://x402.org/facilitator" });

    function requirementsFor(resourceUrl: string) {
      return {
        scheme: "exact" as const,
        network: "base-sepolia" as const,
        maxAmountRequired: PRICE,
        resource: resourceUrl,
        description: "Tollgate live integration test resource",
        mimeType: "application/json",
        payTo: seller.address,
        maxTimeoutSeconds: 60,
        asset: USDC_ASSET,
        extra: { name: "USDC", version: "2" },
      };
    }

    server = createServer(async (req, res) => {
      const resourceUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}${req.url}`;
      const requirements = requirementsFor(resourceUrl);
      const paymentHeader = req.headers["x-payment"];

      if (!paymentHeader) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ x402Version: 1, accepts: [requirements] }));
        return;
      }

      const payload = JSON.parse(Buffer.from(String(paymentHeader), "base64").toString());
      const verifyResult = await facilitator.verify(payload, requirements);
      if (!verifyResult.isValid) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ x402Version: 1, error: verifyResult.invalidReason, accepts: [requirements] }));
        return;
      }

      const settleResult = await facilitator.settle(payload, requirements);
      if (!settleResult.success) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ x402Version: 1, error: settleResult.errorReason, accepts: [requirements] }));
        return;
      }

      const paymentResponseHeader = Buffer.from(
        JSON.stringify({ success: true, transaction: settleResult.transaction, network: settleResult.network, payer: settleResult.payer }),
      ).toString("base64");
      res.writeHead(200, { "content-type": "application/json", "x-payment-response": paymentResponseHeader });
      res.end(JSON.stringify({ data: "paid resource" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "pays a real seller for real testnet USDC via the public x402.org facilitator, with a real on-chain settlement, and caches it",
    async () => {
      const buyer = privateKeyToAccount(buyerKey!);
      const publicClient = createPublicClient({ chain: baseSepolia, transport: viemHttp() });
      const balanceBefore = await getUSDCBalance(publicClient, buyer.address);

      const tollgate = createTollgate({ wallet: new ViemWalletAdapter(buyerKey!), dbPath });
      const response = await tollgate.fetch(`${baseUrl}/paid-resource`, {}, { taskId: "live-integration-test" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: "paid resource" });

      const rows = tollgate.ledger.all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "paid", amount: PRICE, asset: USDC_ASSET, network: "base-sepolia" });
      expect(rows[0].txRef).toMatch(/^0x[0-9a-fA-F]{64}$/); // a real settlement hash, not a mock's placeholder

      const receipt = await publicClient.waitForTransactionReceipt({ hash: rows[0].txRef as `0x${string}`, timeout: 60_000 });
      expect(receipt.status).toBe("success");

      // Public RPC endpoints can lag a few seconds behind the node that
      // confirmed the receipt (eventual consistency across a load-balanced
      // cluster) — poll instead of trusting a single read right after
      // waitForTransactionReceipt resolves. Inlined (rather than a helper
      // function) so the client's inferred generic type is preserved at
      // each call site — extracting it into a typed parameter breaks
      // viem's structural typing across the function boundary.
      let balanceAfterFirstPay = await getUSDCBalance(publicClient, buyer.address);
      for (let i = 0; i < 10 && balanceAfterFirstPay === balanceBefore; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        balanceAfterFirstPay = await getUSDCBalance(publicClient, buyer.address);
      }
      expect(balanceBefore - balanceAfterFirstPay).toBe(BigInt(PRICE));

      // Prove caching saves a real payment, not just a call to a mock server:
      // a second identical request must be a cache hit — no second signature,
      // no second facilitator round trip, no second on-chain transaction, and
      // critically, no further USDC spent.
      const second = await tollgate.fetch(`${baseUrl}/paid-resource`, {}, { taskId: "live-integration-test" });
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ data: "paid resource" });

      const rowsAfterCacheHit = tollgate.ledger.all();
      expect(rowsAfterCacheHit).toHaveLength(2);
      expect(rowsAfterCacheHit[1]).toMatchObject({ outcome: "cache_hit", amount: PRICE, txRef: rows[0].txRef });

      const balanceAfterCacheHit = await getUSDCBalance(publicClient, buyer.address);
      expect(balanceAfterCacheHit).toBe(balanceAfterFirstPay); // unchanged — no second payment happened

      tollgate.ledger.close();
    },
    120_000,
  );
});
