import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTollgate } from "../src/interceptor.js";
import { MockWalletAdapter } from "../../adapters/src/mock.js";
import { validEnvelope, validPaymentRequirements } from "./fixtures.js";

let server: Server;
let baseUrl: string;
let dir: string;
let dbPath: string;
let requestCount: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tollgate-interceptor-"));
  dbPath = join(dir, "tollgate.db");
  requestCount = 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function listen(handler: (req: IncomingMessage, res: ServerResponse, count: number) => void): Promise<void> {
  server = createServer((req, res) => {
    requestCount += 1;
    handler(req, res, requestCount);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        baseUrl = `http://127.0.0.1:${address.port}`;
      }
      resolve();
    });
  });
}

/** Standard payment-gated handler: 402 with a valid envelope until it sees
 * X-PAYMENT, then 200. Path-aware so cache-isolation tests can distinguish
 * endpoints, and supports a custom X-PAYMENT-RESPONSE header for txRef tests. */
function payHandler(opts: { paymentResponseHeader?: string } = {}) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const paymentHeader = req.headers["x-payment"];
    if (!paymentHeader) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify(validEnvelope()));
      return;
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.paymentResponseHeader) headers["x-payment-response"] = opts.paymentResponseHeader;
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true }));
  };
}

describe("createTollgate — end-to-end request lifecycle", () => {
  it("pays on 402, retries with the X-PAYMENT header, and records a paid ledger row", async () => {
    let capturedPaymentHeader: string | undefined;
    await listen((req, res) => {
      const paymentHeader = req.headers["x-payment"];
      if (!paymentHeader) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify(validEnvelope()));
        return;
      }
      capturedPaymentHeader = Array.isArray(paymentHeader) ? paymentHeader[0] : paymentHeader;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    const response = await tollgate.fetch(`${baseUrl}/data`, {}, { taskId: "task-1", agentId: "agent-1" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(capturedPaymentHeader).toBeTruthy();

    const rows = tollgate.ledger.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "paid",
      taskId: "task-1",
      agentId: "agent-1",
      amount: validPaymentRequirements().maxAmountRequired,
      asset: validPaymentRequirements().asset,
      network: validPaymentRequirements().network,
      txRef: "mock-tx-1",
    });
    expect(rows[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].latencyMs).toBeGreaterThanOrEqual(0);

    tollgate.ledger.close();
  });

  it("passes through a free (200-on-first-try) endpoint untouched, no ledger row", async () => {
    await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ free: true }));
    });

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    const response = await tollgate.fetch(`${baseUrl}/free`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ free: true });
    expect(tollgate.ledger.all()).toHaveLength(0);

    tollgate.ledger.close();
  });

  it("cache only applies to the paid path — a free endpoint hit twice still hits the server twice", async () => {
    await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ free: true }));
    });

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    await tollgate.fetch(`${baseUrl}/free`);
    await tollgate.fetch(`${baseUrl}/free`);

    expect(requestCount).toBe(2);
    expect(tollgate.ledger.all()).toHaveLength(0);

    tollgate.ledger.close();
  });

  it("passes through a non-402 error response untouched, no ledger row", async () => {
    await listen((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    const response = await tollgate.fetch(`${baseUrl}/broken`);

    expect(response.status).toBe(500);
    expect(tollgate.ledger.all()).toHaveLength(0);

    tollgate.ledger.close();
  });

  it("fails closed and writes a denied row when wallet.authorize rejects its promise", async () => {
    await listen(payHandler());

    const tollgate = createTollgate({ wallet: new MockWalletAdapter({ failAuthorize: true }), dbPath });
    await expect(tollgate.fetch(`${baseUrl}/data`)).rejects.toMatchObject({ code: "wallet_authorize_failed" });

    const rows = tollgate.ledger.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("denied");

    tollgate.ledger.close();
  });

  it("fails closed and writes a denied row when wallet.authorize throws synchronously", async () => {
    await listen(payHandler());

    const throwingWallet = {
      quote: async (req: { maxAmountRequired: string; asset: string; network: string }) => ({
        amount: req.maxAmountRequired,
        asset: req.asset,
        network: req.network,
      }),
      authorize: () => {
        throw new Error("synchronous wallet failure");
      },
      balance: async () => ({ asset: "USDC", amount: "0" }),
    };

    const tollgate = createTollgate({ wallet: throwingWallet, dbPath });
    await expect(tollgate.fetch(`${baseUrl}/data`)).rejects.toMatchObject({ code: "wallet_authorize_failed" });

    const rows = tollgate.ledger.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("denied");

    tollgate.ledger.close();
  });

  it("writes a disputed row when payment settles but the retry fails", async () => {
    await listen((req, res) => {
      const paymentHeader = req.headers["x-payment"];
      if (!paymentHeader) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify(validEnvelope()));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "seller failed after payment" }));
    });

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    await expect(tollgate.fetch(`${baseUrl}/data`)).rejects.toMatchObject({ code: "payment_disputed" });

    const rows = tollgate.ledger.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "disputed", txRef: "mock-tx-1" });

    tollgate.ledger.close();
  });

  it("aborts with price_mismatch when the retry 402 changes the recipient", async () => {
    await listen((req, res) => {
      const paymentHeader = req.headers["x-payment"];
      if (!paymentHeader) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify(validEnvelope()));
        return;
      }
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify(validEnvelope({ payTo: "0x9999999999999999999999999999999999999999" })));
    });

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    await expect(tollgate.fetch(`${baseUrl}/data`)).rejects.toMatchObject({ code: "price_mismatch" });

    const rows = tollgate.ledger.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("disputed");
    expect(rows.some((r) => r.outcome === "paid")).toBe(false);

    tollgate.ledger.close();
  });
});

describe("createTollgate — cache", () => {
  it("second identical call is a cache hit — no second network round trip", async () => {
    await listen(payHandler());

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    await tollgate.fetch(`${baseUrl}/data`);
    expect(requestCount).toBe(2); // 402 probe + paid retry

    const second = await tollgate.fetch(`${baseUrl}/data`);
    expect(requestCount).toBe(2); // unchanged — served from cache
    expect(await second.json()).toEqual({ ok: true });

    const rows = tollgate.ledger.all();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ outcome: "cache_hit", amount: validPaymentRequirements().maxAmountRequired });

    tollgate.ledger.close();
  });

  it("respects TTL expiry — a stale cache entry triggers a fresh payment", async () => {
    await listen(payHandler());

    let currentTime = 1_000_000;
    const now = () => currentTime;
    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath, cacheTtlMs: 1000, now });

    await tollgate.fetch(`${baseUrl}/data`);
    expect(requestCount).toBe(2);

    currentTime += 2000; // past the 1000ms TTL
    await tollgate.fetch(`${baseUrl}/data`);
    expect(requestCount).toBe(4); // fresh 402 probe + paid retry

    tollgate.ledger.close();
  });

  it("Cache-Control: no-cache skips lookup, write, and single-flight — always hits the server", async () => {
    await listen(payHandler());

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    const noCacheInit = { headers: { "Cache-Control": "no-cache" } };

    await tollgate.fetch(`${baseUrl}/data`, noCacheInit);
    expect(requestCount).toBe(2);
    await tollgate.fetch(`${baseUrl}/data`, noCacheInit);
    expect(requestCount).toBe(4);

    const rows = tollgate.ledger.all();
    expect(rows.every((r) => r.outcome === "paid")).toBe(true);
    expect(rows).toHaveLength(2);

    tollgate.ledger.close();
  });

  it("cache key isolation — different endpoints never share a cache entry", async () => {
    await listen(payHandler());

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    await tollgate.fetch(`${baseUrl}/data-a`);
    await tollgate.fetch(`${baseUrl}/data-b`);

    expect(requestCount).toBe(4); // two independent 402+pay sequences
    expect(tollgate.ledger.all().filter((r) => r.outcome === "paid")).toHaveLength(2);

    tollgate.ledger.close();
  });

  it("decodes the real settlement tx hash from X-PAYMENT-RESPONSE when present", async () => {
    const paymentResponsePayload = { success: true, transaction: "0xrealsettlementhash", network: "base-sepolia", payer: "0xpayer" };
    const encoded = Buffer.from(JSON.stringify(paymentResponsePayload)).toString("base64");
    await listen(payHandler({ paymentResponseHeader: encoded }));

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    await tollgate.fetch(`${baseUrl}/data`);

    const rows = tollgate.ledger.all();
    expect(rows[0].txRef).toBe("0xrealsettlementhash");

    tollgate.ledger.close();
  });

  it("falls back to the wallet's own txRef when X-PAYMENT-RESPONSE is malformed", async () => {
    await listen(payHandler({ paymentResponseHeader: "not-valid-base64-json!!!" }));

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    await tollgate.fetch(`${baseUrl}/data`);

    const rows = tollgate.ledger.all();
    expect(rows[0].txRef).toBe("mock-tx-1");

    tollgate.ledger.close();
  });
});

describe("createTollgate — single-flight", () => {
  it("collapses N concurrent identical requests into one payment and one ledger row", async () => {
    await listen(payHandler());

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    const responses = await Promise.all(Array.from({ length: 5 }, () => tollgate.fetch(`${baseUrl}/data`)));

    expect(requestCount).toBe(2); // one 402 probe + one paid retry, shared by all 5
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(await res.clone().json()).toEqual({ ok: true });
    }

    expect(tollgate.ledger.all()).toHaveLength(1);

    tollgate.ledger.close();
  });

  it("shares a rejection across concurrent callers, then allows a fresh attempt afterward", async () => {
    await listen(payHandler());

    const tollgate = createTollgate({ wallet: new MockWalletAdapter({ failAuthorize: true }), dbPath });
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => tollgate.fetch(`${baseUrl}/data`)));

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(tollgate.ledger.all()).toHaveLength(1);
    expect(tollgate.ledger.all()[0].outcome).toBe("denied");

    // in-flight entry must be cleared — a subsequent call starts a fresh attempt, not a stuck stale promise
    await expect(tollgate.fetch(`${baseUrl}/data`)).rejects.toMatchObject({ code: "wallet_authorize_failed" });
    expect(tollgate.ledger.all()).toHaveLength(2);

    tollgate.ledger.close();
  });

  it("writes to the cache exactly once despite N concurrent followers", async () => {
    await listen(payHandler());

    const tollgate = createTollgate({ wallet: new MockWalletAdapter(), dbPath });
    await Promise.all(Array.from({ length: 4 }, () => tollgate.fetch(`${baseUrl}/data`)));
    expect(requestCount).toBe(2);

    const followUp = await tollgate.fetch(`${baseUrl}/data`);
    expect(requestCount).toBe(2); // still cached, no new network hit
    expect(await followUp.json()).toEqual({ ok: true });

    tollgate.ledger.close();
  });
});
