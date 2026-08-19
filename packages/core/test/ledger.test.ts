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
      recipient: "0xabc",
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

describe("Ledger.sumPaid", () => {
  function paidRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
    return {
      id: generateId(),
      ts: 1000,
      endpoint: "https://api.example.com/data",
      outcome: "paid",
      amount: "10000",
      asset: "USDC",
      network: "base-sepolia",
      requestHash: generateId(),
      latencyMs: 1,
      ...overrides,
    };
  }

  it("sums only outcome='paid' rows matching asset+network", () => {
    ledger.insert(paidRow({ amount: "10000" }));
    ledger.insert(paidRow({ amount: "20000" }));
    ledger.insert(paidRow({ amount: "99999", outcome: "denied" })); // not paid, must not count
    ledger.insert(paidRow({ amount: "99999", asset: "OTHER" })); // different asset, must not count

    expect(ledger.sumPaid({ asset: "USDC", network: "base-sepolia" })).toBe(30000n);
  });

  it("filters by taskId when given", () => {
    ledger.insert(paidRow({ amount: "10000", taskId: "task-a" }));
    ledger.insert(paidRow({ amount: "20000", taskId: "task-b" }));

    expect(ledger.sumPaid({ asset: "USDC", network: "base-sepolia", taskId: "task-a" })).toBe(10000n);
  });

  it("filters by sinceTs, respecting a UTC day boundary", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const todayStart = 10 * dayMs;
    ledger.insert(paidRow({ amount: "10000", ts: todayStart - 1 })); // yesterday, excluded
    ledger.insert(paidRow({ amount: "20000", ts: todayStart })); // today, included
    ledger.insert(paidRow({ amount: "30000", ts: todayStart + 1000 })); // today, included

    expect(ledger.sumPaid({ asset: "USDC", network: "base-sepolia", sinceTs: todayStart })).toBe(50000n);
  });

  it("returns 0n when nothing matches", () => {
    expect(ledger.sumPaid({ asset: "USDC", network: "base-sepolia" })).toBe(0n);
  });
});

describe("Ledger.countPaid", () => {
  it("counts only outcome='paid' rows for the given task+endpoint", () => {
    ledger.insert({ id: generateId(), ts: 1, taskId: "task-a", endpoint: "e1", outcome: "paid", requestHash: generateId(), latencyMs: 1 });
    ledger.insert({ id: generateId(), ts: 2, taskId: "task-a", endpoint: "e1", outcome: "paid", requestHash: generateId(), latencyMs: 1 });
    ledger.insert({ id: generateId(), ts: 3, taskId: "task-a", endpoint: "e1", outcome: "denied", requestHash: generateId(), latencyMs: 1 });
    ledger.insert({ id: generateId(), ts: 4, taskId: "task-a", endpoint: "e2", outcome: "paid", requestHash: generateId(), latencyMs: 1 });
    ledger.insert({ id: generateId(), ts: 5, taskId: "task-b", endpoint: "e1", outcome: "paid", requestHash: generateId(), latencyMs: 1 });

    expect(ledger.countPaid({ taskId: "task-a", endpoint: "e1" })).toBe(2);
  });

  it("returns 0 when nothing matches", () => {
    expect(ledger.countPaid({ taskId: "task-a", endpoint: "e1" })).toBe(0);
  });
});

describe("Ledger.hasEverPaid", () => {
  it("returns true once a recipient has a paid row", () => {
    ledger.insert({ id: generateId(), ts: 1, endpoint: "e1", outcome: "paid", recipient: "0xabc", requestHash: generateId(), latencyMs: 1 });
    expect(ledger.hasEverPaid("0xabc")).toBe(true);
  });

  it("returns false for a recipient with no rows at all", () => {
    expect(ledger.hasEverPaid("0xnever-seen")).toBe(false);
  });

  it("returns false when the only row for a recipient is denied, not paid — the outcome filter must be exact", () => {
    ledger.insert({ id: generateId(), ts: 1, endpoint: "e1", outcome: "denied", recipient: "0xabc", requestHash: generateId(), latencyMs: 1 });
    expect(ledger.hasEverPaid("0xabc")).toBe(false);
  });
});

describe("generateId", () => {
  it("produces unique ids across many calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    expect(ids.size).toBe(1000);
  });
});
