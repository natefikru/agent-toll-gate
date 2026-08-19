import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Ledger } from "../../core/src/ledger.js";
import type { LedgerRow } from "../../core/src/types.js";

/**
 * index.ts does a real (non-type-only) import of @tollgate/core, so the
 * compiled CLI needs core's dist to exist. Two in-process approaches were
 * tried and both failed: a plain dynamic `import("@tollgate/core")` and the
 * same with `@vite-ignore` — vitest's Vite-based resolver fails at actual
 * runtime resolution for an unbuilt package, not just its static import
 * analysis, so neither defers past the build step below. The reliable fix
 * is running the real compiled binary as a subprocess, which uses plain
 * Node module resolution and sidesteps Vite's resolver entirely — this also
 * exercises exactly what a real user runs, which is arguably more faithful
 * than importing an internal function would have been anyway.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliEntry = join(repoRoot, "packages/cli/dist/index.js");

beforeAll(() => {
  execSync("npx tsc -b packages/core/tsconfig.json packages/cli/tsconfig.json", { cwd: repoRoot, stdio: "pipe" });
}, 60_000);

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tollgate-cli-"));
  dbPath = join(dir, "tollgate.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedLedger(rows: Partial<LedgerRow>[]): void {
  const ledger = new Ledger(dbPath);
  let i = 0;
  for (const overrides of rows) {
    i += 1;
    ledger.insert({
      id: `row-${i}`,
      ts: Date.now(),
      endpoint: "https://api.example.com/data",
      outcome: "paid",
      amount: "10000",
      asset: "USDC",
      network: "base-sepolia",
      requestHash: `hash-${i}`,
      latencyMs: 1,
      ...overrides,
    });
  }
  ledger.close();
}

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [cliEntry, "report", ...args], { encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: (e.stdout ?? "") + (e.stderr ?? ""), status: e.status ?? 1 };
  }
}

describe("tollgate report CLI (compiled binary)", () => {
  it("produces --json output that parses to the expected report shape", () => {
    seedLedger([{ outcome: "paid", amount: "10000" }, { outcome: "cache_hit", amount: "10000" }]);

    const { stdout, status } = runCli(["--db", dbPath, "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);

    expect(parsed.byAsset).toHaveLength(1);
    expect(parsed.byAsset[0].totalPaid).toBe("10000");
    expect(parsed.byAsset[0].totalSaved).toBe("10000");
    expect(parsed.cacheHitRate).toBeCloseTo(0.5);
  });

  it("produces human-readable output without throwing", () => {
    seedLedger([{ outcome: "paid" }, { outcome: "denied", amount: undefined, asset: undefined, network: undefined }]);

    const { stdout, status } = runCli(["--db", dbPath]);
    expect(status).toBe(0);
    expect(stdout).toContain("Spend by asset/network");
    expect(stdout).toContain("Denials");
  });

  it("exits non-zero with a clear error when --db points at a nonexistent file", () => {
    const { stdout, status } = runCli(["--db", join(dir, "nope.db")]);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/no such database file/);
  });

  it("rejects an invalid --since value with a clear error, not silent garbage filtering", () => {
    seedLedger([{ outcome: "paid" }]);
    const { stdout, status } = runCli(["--db", dbPath, "--since", "not-a-date"]);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/invalid --since/);
  });

  it("accepts a valid --since value (epoch-ms) and filters rows before it", () => {
    seedLedger([{ ts: 1000, amount: "1" }, { ts: 5000, amount: "2" }]);
    const { stdout, status } = runCli(["--db", dbPath, "--since", "3000", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.byAsset[0].totalPaid).toBe("2");
  });

  it("--task matching zero rows is not an error — just an empty report", () => {
    seedLedger([{ outcome: "paid", taskId: "task-a" }]);
    const { stdout, status } = runCli(["--db", dbPath, "--task", "task-nonexistent", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.byAsset).toHaveLength(0);
  });
});
