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

  constructor(dbPath = "./tollgate.db") {
    this.db = new Database(dbPath);
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
        txRef TEXT,
        requestHash TEXT NOT NULL,
        latencyMs INTEGER NOT NULL
      )
    `);
  }

  insert(row: LedgerRow): void {
    this.db
      .prepare(
        `INSERT INTO ledger (id, ts, taskId, agentId, endpoint, outcome, amount, asset, network, txRef, requestHash, latencyMs)
         VALUES (@id, @ts, @taskId, @agentId, @endpoint, @outcome, @amount, @asset, @network, @txRef, @requestHash, @latencyMs)`,
      )
      .run({
        ...row,
        taskId: row.taskId ?? null,
        agentId: row.agentId ?? null,
        amount: row.amount ?? null,
        asset: row.asset ?? null,
        network: row.network ?? null,
        txRef: row.txRef ?? null,
      });
  }

  /** Exists for tests to assert on written rows. No query/report surface
   * yet — that's Week 3 dashboard/CLI territory. */
  all(): LedgerRow[] {
    return this.db.prepare(`SELECT * FROM ledger ORDER BY ts ASC`).all() as LedgerRow[];
  }

  close(): void {
    this.db.close();
  }
}
