import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTollgate } from "../src/interceptor.js";
import { MockWalletAdapter } from "../../adapters/src/mock.js";

function envelope(overrides: Partial<{ payTo: string; maxAmountRequired: string }> = {}) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: overrides.maxAmountRequired ?? "50000",
        resource: "https://api.example.com/data",
        description: "test resource",
        mimeType: "application/json",
        payTo: overrides.payTo ?? "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 60,
        asset: "0x2222222222222222222222222222222222222222",
      },
    ],
  };
}

let server: Server;
let baseUrl: string;
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tollgate-interceptor-"));
  dbPath = join(dir, "tollgate.db");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
  server = createServer(handler);
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

describe("createTollgate — end-to-end request lifecycle", () => {
  it("pays on 402, retries with the X-PAYMENT header, and records a paid ledger row", async () => {
    let capturedPaymentHeader: string | undefined;

    await listen((req, res) => {
      const paymentHeader = req.headers["x-payment"];
      if (!paymentHeader) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify(envelope()));
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
      amount: "50000",
      asset: "0x2222222222222222222222222222222222222222",
      network: "base-sepolia",
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
    await listen((_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify(envelope()));
    });

    const tollgate = createTollgate({ wallet: new MockWalletAdapter({ failAuthorize: true }), dbPath });
    await expect(tollgate.fetch(`${baseUrl}/data`)).rejects.toMatchObject({ code: "wallet_authorize_failed" });

    const rows = tollgate.ledger.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("denied");

    tollgate.ledger.close();
  });

  it("fails closed and writes a denied row when wallet.authorize throws synchronously", async () => {
    await listen((_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify(envelope()));
    });

    const throwingWallet = {
      quote: async (req: { price: string; asset: string; network: string }) => ({
        amount: req.price,
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
        res.end(JSON.stringify(envelope()));
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
        res.end(JSON.stringify(envelope()));
        return;
      }
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify(envelope({ payTo: "0x9999999999999999999999999999999999999999" })));
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
