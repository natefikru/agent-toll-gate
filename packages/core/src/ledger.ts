import Database from "better-sqlite3";
import type { LedgerRow } from "./types.js";

let counter = 0;

/** Timestamp-prefixed, monotonic-per-process suffix. Good enough for a
 * single-instance MVP; revisit if collision-resistance across processes
 * becomes a real concern. */
export function generateId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class Ledger {
  private db: Database.Database;

  /** Accepts either a path (opens its own connection) or an already-open
   * Database instance to share with other stores (e.g. SqliteCacheStore) —
   * avoids two separate connections to the same SQLite file. */
  constructor(dbOrPath: Database.Database | string = "./tollgate.db") {
    this.db = typeof dbOrPath === "string" ? new Database(dbOrPath) : dbOrPath;
    // NOTE: CREATE TABLE IF NOT EXISTS does not add columns to a table that
    // already exists on disk. A local tollgate.db created before `recipient`
    // was added will hit "no such column: recipient" on the first insert()
    // after upgrading — there is no migration path yet; delete the local
    // .db file and let it recreate.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        taskId TEXT,
        agentId TEXT,
        endpoint TEXT NOT NULL,
        outcome TEXT NOT NULL,
        amount TEXT,
        asset TEXT,
        network TEXT,
        recipient TEXT,
        txRef TEXT,
        requestHash TEXT NOT NULL,
        latencyMs INTEGER NOT NULL
      )
    `);
  }

  insert(row: LedgerRow): void {
    this.db
      .prepare(
        `INSERT INTO ledger (id, ts, taskId, agentId, endpoint, outcome, amount, asset, network, recipient, txRef, requestHash, latencyMs)
         VALUES (@id, @ts, @taskId, @agentId, @endpoint, @outcome, @amount, @asset, @network, @recipient, @txRef, @requestHash, @latencyMs)`,
      )
      .run({
        ...row,
        taskId: row.taskId ?? null,
        agentId: row.agentId ?? null,
        amount: row.amount ?? null,
        asset: row.asset ?? null,
        network: row.network ?? null,
        recipient: row.recipient ?? null,
        txRef: row.txRef ?? null,
      });
  }

  /** Exposes the underlying connection so other stores (SqliteCacheStore)
   * can share it instead of opening a second connection to the same file. */
  get database(): Database.Database {
    return this.db;
  }

  /** Exists for tests to assert on written rows. No general query/report
   * surface yet — that's Week 3 dashboard/CLI territory. sumPaid/countPaid/
   * hasEverPaid below are the narrow exceptions, needed by the policy engine. */
  all(): LedgerRow[] {
    return this.db.prepare(`SELECT * FROM ledger ORDER BY ts ASC`).all() as LedgerRow[];
  }

  /** Sums `amount` as BigInt over outcome='paid' rows only — cache_hit rows
   * never represent real spend (see the Week 2 ledger convention). Powers
   * perTaskBudget (filter by taskId) and dailyBudget (filter by sinceTs). */
  sumPaid(filter: { asset: string; network: string; taskId?: string; sinceTs?: number }): bigint {
    let sql = `SELECT amount FROM ledger WHERE outcome = 'paid' AND asset = @asset AND network = @network`;
    const params: Record<string, string | number> = { asset: filter.asset, network: filter.network };
    if (filter.taskId !== undefined) {
      sql += ` AND taskId = @taskId`;
      params.taskId = filter.taskId;
    }
    if (filter.sinceTs !== undefined) {
      sql += ` AND ts >= @sinceTs`;
      params.sinceTs = filter.sinceTs;
    }
    const rows = this.db.prepare(sql).all(params) as { amount: string }[];
    return rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  }

  /** Counts outcome='paid' rows for a task+endpoint. Powers
   * maxCallsPerTaskPerEndpoint. */
  countPaid(filter: { taskId?: string; endpoint: string }): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM ledger WHERE outcome = 'paid' AND taskId = @taskId AND endpoint = @endpoint`)
      .get({ taskId: filter.taskId ?? null, endpoint: filter.endpoint }) as { count: number };
    return row.count;
  }

  /** True only if this recipient has been genuinely paid before — denied or
   * disputed rows for the same recipient don't count as "seen". Powers
   * onFirstSeenEscalate. */
  hasEverPaid(recipient: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM ledger WHERE outcome = 'paid' AND recipient = @recipient LIMIT 1`)
      .get({ recipient });
    return row !== undefined;
  }

  close(): void {
    this.db.close();
  }
}
