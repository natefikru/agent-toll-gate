import { describe, it, expect } from "vitest";
import { buildReport, explorerTxUrl, reportToJson } from "../src/report.js";
import type { LedgerRow } from "@tollgate/core";

let idCounter = 0;
function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  idCounter += 1;
  return {
    id: `row-${idCounter}`,
    ts: 1_000_000,
    endpoint: "https://api.example.com/data",
    outcome: "paid",
    amount: "10000",
    asset: "USDC",
    network: "base-sepolia",
    requestHash: `hash-${idCounter}`,
    latencyMs: 5,
    ...overrides,
  };
}

describe("buildReport — bucketing", () => {
  it("buckets by asset/network, sorted by asset then network", () => {
    const report = buildReport([
      row({ asset: "USDC", network: "base", amount: "1" }),
      row({ asset: "USDC", network: "base-sepolia", amount: "2" }),
      row({ asset: "DAI", network: "base", amount: "3" }),
    ]);
    expect(report.byAsset.map((b) => [b.asset, b.network])).toEqual([
      ["DAI", "base"],
      ["USDC", "base"],
      ["USDC", "base-sepolia"],
    ]);
  });

  it("sums totalPaid per bucket correctly", () => {
    const report = buildReport([row({ amount: "10000" }), row({ amount: "20000" })]);
    expect(report.byAsset).toHaveLength(1);
    expect(report.byAsset[0].totalPaid).toBe(30000n);
    expect(report.byAsset[0].paidCount).toBe(2);
  });

  it("groups by task, agent, and endpoint with sorted keys", () => {
    const report = buildReport([
      row({ taskId: "task-b", agentId: "agent-1", endpoint: "e1" }),
      row({ taskId: "task-a", agentId: "agent-2", endpoint: "e2" }),
    ]);
    expect(Object.keys(report.byTask)).toEqual(["task-a", "task-b"]);
    expect(Object.keys(report.byAgent)).toEqual(["agent-1", "agent-2"]);
    expect(Object.keys(report.byEndpoint)).toEqual(["e1", "e2"]);
  });

  it("groups rows with no taskId under the empty-string key, including the real null shape from SQLite", () => {
    const report = buildReport([row({ taskId: undefined }), row({ taskId: null as unknown as undefined })]);
    expect(Object.keys(report.byTask)).toEqual([""]);
    expect(report.byTask[""][0].paidCount).toBe(2);
  });
});

describe("buildReport — cache_hit vs paid", () => {
  it("cache_hit rows contribute to totalSaved/cacheHitCount, never totalPaid", () => {
    const report = buildReport([row({ outcome: "paid", amount: "10000" }), row({ outcome: "cache_hit", amount: "10000" })]);
    const bucket = report.byAsset[0];
    expect(bucket.totalPaid).toBe(10000n);
    expect(bucket.totalSaved).toBe(10000n);
    expect(bucket.paidCount).toBe(1);
    expect(bucket.cacheHitCount).toBe(1);
  });
});

describe("buildReport — denied/disputed/escalated never affect spend buckets", () => {
  it("excludes denied, disputed, and escalated rows from every spend bucket", () => {
    const report = buildReport([
      row({ outcome: "denied", amount: "99999" }),
      row({ outcome: "disputed", amount: "99999" }),
      row({ outcome: "escalated", amount: "99999" }),
    ]);
    expect(report.byAsset).toHaveLength(0);
  });

  it("does not throw on a denial with a null amount (the policy_denied_domain case)", () => {
    expect(() =>
      buildReport([row({ outcome: "denied", amount: undefined, asset: undefined, network: undefined })]),
    ).not.toThrow();
    const report = buildReport([row({ outcome: "denied", amount: undefined, asset: undefined, network: undefined })]);
    expect(report.byAsset).toHaveLength(0);
    expect(report.denials).toHaveLength(1);
  });
});

describe("buildReport — history sections", () => {
  it("each history section only contains its own outcome, sorted most-recent-first", () => {
    const report = buildReport([
      row({ outcome: "escalated", ts: 100 }),
      row({ outcome: "escalated", ts: 300 }),
      row({ outcome: "denied", ts: 200 }),
      row({ outcome: "disputed", ts: 150 }),
      row({ outcome: "paid", ts: 250 }),
    ]);
    expect(report.escalations.map((r) => r.ts)).toEqual([300, 100]);
    expect(report.denials.map((r) => r.ts)).toEqual([200]);
    expect(report.disputes.map((r) => r.ts)).toEqual([150]);
    expect(report.recentReceipts.map((r) => r.ts)).toEqual([250]);
  });

  it("respects historyLimit across all four sections, not just receipts", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ outcome: "escalated", ts: i }));
    const report = buildReport(rows, { historyLimit: 2 });
    expect(report.escalations).toHaveLength(2);
    expect(report.escalations.map((r) => r.ts)).toEqual([4, 3]);
  });
});

describe("buildReport — cacheHitRate", () => {
  it("computes the overall cache hit rate", () => {
    const report = buildReport([row({ outcome: "paid" }), row({ outcome: "paid" }), row({ outcome: "cache_hit" })]);
    expect(report.cacheHitRate).toBeCloseTo(1 / 3);
  });

  it("is 0, not NaN, on an empty ledger", () => {
    const report = buildReport([]);
    expect(report.cacheHitRate).toBe(0);
  });
});

describe("buildReport — filters", () => {
  it("filters by taskId", () => {
    const report = buildReport([row({ taskId: "task-a", amount: "1" }), row({ taskId: "task-b", amount: "2" })], {
      taskId: "task-a",
    });
    expect(report.byAsset[0].totalPaid).toBe(1n);
  });

  it("filters by sinceTs", () => {
    const report = buildReport([row({ ts: 100, amount: "1" }), row({ ts: 200, amount: "2" })], { sinceTs: 150 });
    expect(report.byAsset[0].totalPaid).toBe(2n);
  });
});

describe("explorerTxUrl", () => {
  it("returns a Basescan link for base-sepolia and base", () => {
    expect(explorerTxUrl("base-sepolia", "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
    expect(explorerTxUrl("base", "0xabc")).toBe("https://basescan.org/tx/0xabc");
  });

  it("returns undefined for an unrecognized network", () => {
    expect(explorerTxUrl("polygon", "0xabc")).toBeUndefined();
  });

  it("returns undefined when txRef is missing (the normal shape for a denial/escalation)", () => {
    expect(explorerTxUrl("base-sepolia", null)).toBeUndefined();
    expect(explorerTxUrl("base-sepolia", undefined)).toBeUndefined();
  });
});

describe("reportToJson", () => {
  it("round-trips large BigInt totals as decimal strings with no precision loss", () => {
    const huge = (BigInt(Number.MAX_SAFE_INTEGER) * 1000n).toString();
    const report = buildReport([row({ amount: huge })]);
    const parsed = JSON.parse(reportToJson(report));
    expect(parsed.byAsset[0].totalPaid).toBe(huge);
  });
});
