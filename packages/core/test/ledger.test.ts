import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, generateId } from "../src/ledger.js";
import type { LedgerRow } from "../src/types.js";

let dir: string;
let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tollgate-ledger-"));
  dbPath = join(dir, "tollgate.db");
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Ledger", () => {
  it("round-trips an inserted row with every field intact", () => {
    const row: LedgerRow = {
      id: generateId(),
      ts: 1234567890,
      taskId: "task-1",
      agentId: "agent-1",
      endpoint: "https://api.example.com/data",
      outcome: "paid",
      amount: "0.05",
      asset: "USDC",
      network: "base-sepolia",
      txRef: "mock-tx-1",
      requestHash: "deadbeef",
      latencyMs: 42,
    };

    ledger.insert(row);
    const rows = ledger.all();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(row);
  });

  it("stores optional fields as null when absent, not undefined-that-crashes", () => {
    const row: LedgerRow = {
      id: generateId(),
      ts: Date.now(),
      endpoint: "https://api.example.com/data",
      outcome: "denied",
      requestHash: "cafebabe",
      latencyMs: 5,
    };

    expect(() => ledger.insert(row)).not.toThrow();
    const [stored] = ledger.all();
    expect(stored.taskId).toBeNull();
    expect(stored.amount).toBeNull();
  });

  it("orders rows by timestamp ascending", () => {
    ledger.insert({ id: generateId(), ts: 200, endpoint: "b", outcome: "paid", requestHash: "h2", latencyMs: 1 });
    ledger.insert({ id: generateId(), ts: 100, endpoint: "a", outcome: "paid", requestHash: "h1", latencyMs: 1 });

    const rows = ledger.all();
    expect(rows.map((r) => r.endpoint)).toEqual(["a", "b"]);
  });
});

describe("generateId", () => {
  it("produces unique ids across many calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    expect(ids.size).toBe(1000);
  });
});
