#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
// A real (non-type-only) cross-package import — unlike every other
// cross-package reference in this monorepo so far (all `import type`,
// erased at compile time), this one constructs `new Ledger(...)`, so it
// must resolve through node_modules to core's built dist. That's correct:
// this is production code, a genuine consumer of @tollgate/core, not a
// test reaching into another package's src for convenience. It does mean
// this package's own dist must be built (transitively, core's dist too)
// before either running the compiled CLI or exercising this file in tests
// — see test/cli.test.ts, which builds both before importing this module.
import { Ledger, type LedgerRow } from "@tollgate/core";
import { buildReport, reportToJson, explorerTxUrl, type Report, type SpendBucket } from "./report.js";

export class CliError extends Error {}

/** ISO 8601 or a raw epoch-ms integer only — see the plan's scope decision
 * against a relative-duration shorthand ("24h" etc.): unit vocabulary and
 * anchor point are both unspecified for that format, so it's cut entirely
 * rather than shipped ambiguous. */
export function parseSince(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new CliError(`invalid --since value "${value}" — expected an ISO 8601 timestamp or an epoch-ms integer`);
  }
  return parsed;
}

export interface ReportArgs {
  db: string;
  task?: string;
  since?: number;
  json: boolean;
  limit: number;
}

export function parseReportArgs(argv: string[]): ReportArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: "string", default: "./tollgate.db" },
      task: { type: "string" },
      since: { type: "string" },
      json: { type: "boolean", default: false },
      limit: { type: "string", default: "20" },
    },
  });

  return {
    db: values.db as string,
    task: values.task as string | undefined,
    since: values.since !== undefined ? parseSince(values.since as string) : undefined,
    json: values.json as boolean,
    limit: Number(values.limit),
  };
}

/** Pure(ish) — only I/O is reading the SQLite file at args.db. Returns the
 * rendered output as a string rather than printing directly, so CLI-level
 * tests can call this without shelling out to `node dist/index.js`. */
export function runReport(argv: string[]): string {
  const args = parseReportArgs(argv);
  if (!existsSync(args.db)) {
    throw new CliError(`no such database file: ${args.db}`);
  }

  const ledger = new Ledger(args.db);
  try {
    const report = buildReport(ledger.all(), { taskId: args.task, sinceTs: args.since, historyLimit: args.limit });
    return args.json ? reportToJson(report) : renderHuman(report);
  } finally {
    ledger.close();
  }
}

function formatTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "  (none)";
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => "  " + cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function bucketRows(buckets: SpendBucket[]): string[][] {
  return buckets.map((b) => [b.asset, b.network, b.totalPaid.toString(), b.totalSaved.toString(), String(b.paidCount), String(b.cacheHitCount)]);
}

function bucketHeaders(): string[] {
  return ["Asset", "Network", "Paid", "Saved", "#Paid", "#CacheHits"];
}

function historyRows(rows: LedgerRow[]): string[][] {
  return rows.map((r) => {
    const link = explorerTxUrl(r.network, r.txRef) ?? r.txRef ?? "-";
    return [new Date(r.ts).toISOString(), r.endpoint, r.amount ?? "n/a", r.asset ?? "-", link];
  });
}

function historyHeaders(): string[] {
  return ["Time", "Endpoint", "Amount", "Asset", "Tx"];
}

function renderHuman(report: Report): string {
  const sections: string[] = [];

  sections.push("Spend by asset/network:", formatTable(bucketHeaders(), bucketRows(report.byAsset)));

  for (const [label, groups] of [
    ["task", report.byTask],
    ["agent", report.byAgent],
    ["endpoint", report.byEndpoint],
  ] as const) {
    sections.push(`\nSpend by ${label}:`);
    const groupIds = Object.keys(groups);
    if (groupIds.length === 0) {
      sections.push("  (none)");
      continue;
    }
    for (const groupId of groupIds) {
      sections.push(`  ${groupId || "(none)"}:`);
      sections.push(formatTable(bucketHeaders(), bucketRows(groups[groupId])).replace(/^/gm, "  "));
    }
  }

  sections.push(`\nCache hit rate: ${(report.cacheHitRate * 100).toFixed(1)}%`);

  sections.push("\nRecent receipts:", formatTable(historyHeaders(), historyRows(report.recentReceipts)));
  sections.push("\nEscalations (not approved):", formatTable(historyHeaders(), historyRows(report.escalations)));
  sections.push("\nDenials:", formatTable(historyHeaders(), historyRows(report.denials)));
  sections.push("\nDisputes:", formatTable(historyHeaders(), historyRows(report.disputes)));

  return sections.join("\n");
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand !== "report") {
    console.error("Usage: tollgate report [--db <path>] [--task <id>] [--since <iso8601|epoch-ms>] [--json] [--limit <n>]");
    process.exitCode = 1;
    return;
  }

  try {
    console.log(runReport(rest));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

// Only run when executed directly (`node dist/index.js`), not when imported
// by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
