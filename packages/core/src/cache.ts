import Database from "better-sqlite3";

export interface CacheEntry {
  status: number;
  body: string; // base64 — safe for both text and binary responses
  contentType: string | null;
  amount: string;
  asset: string;
  network: string;
  txRef?: string;
  expiresAt: number;
}

/**
 * Deliberately narrow, matching the WalletAdapter pattern: one interface,
 * one implementation for this pass.
 */
export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

/**
 * SQLite-backed. No eviction/purge of expired rows this pass — expiry is
 * filtered on read, but stale rows are never deleted, so the table grows
 * unboundedly over a long-running process. Explicit, acknowledged deferral.
 */
export class SqliteCacheStore implements CacheStore {
  private db: Database.Database;
  private now: () => number;

  constructor(dbOrPath: Database.Database | string = "./tollgate.db", now: () => number = Date.now) {
    this.db = typeof dbOrPath === "string" ? new Database(dbOrPath) : dbOrPath;
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        status INTEGER NOT NULL,
        body TEXT NOT NULL,
        contentType TEXT,
        amount TEXT NOT NULL,
        asset TEXT NOT NULL,
        network TEXT NOT NULL,
        txRef TEXT,
        expiresAt INTEGER NOT NULL
      )
    `);
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    const row = this.db.prepare(`SELECT * FROM cache WHERE key = ?`).get(key) as (CacheEntry & { key: string }) | undefined;
    if (!row) return undefined;
    if (row.expiresAt <= this.now()) return undefined;
    return {
      status: row.status,
      body: row.body,
      contentType: row.contentType,
      amount: row.amount,
      asset: row.asset,
      network: row.network,
      txRef: row.txRef ?? undefined,
      expiresAt: row.expiresAt,
    };
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO cache (key, status, body, contentType, amount, asset, network, txRef, expiresAt)
         VALUES (@key, @status, @body, @contentType, @amount, @asset, @network, @txRef, @expiresAt)
         ON CONFLICT(key) DO UPDATE SET status=excluded.status, body=excluded.body, contentType=excluded.contentType,
           amount=excluded.amount, asset=excluded.asset, network=excluded.network, txRef=excluded.txRef, expiresAt=excluded.expiresAt`,
      )
      .run({ key, ...entry, contentType: entry.contentType ?? null, txRef: entry.txRef ?? null });
  }
}

/** Reconstructs a Response from a cache hit, restoring only status, body,
 * and content-type — no other original headers are preserved (deliberate
 * trim; nothing downstream needs more yet). */
export function responseFromCacheEntry(entry: CacheEntry): Response {
  const body = Buffer.from(entry.body, "base64");
  const headers: Record<string, string> = {};
  if (entry.contentType) headers["content-type"] = entry.contentType;
  return new Response(body, { status: entry.status, headers });
}

export async function cacheEntryFromResponse(
  res: Response,
  opts: { amount: string; asset: string; network: string; txRef?: string; ttlMs: number; now: () => number },
): Promise<CacheEntry> {
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    body: buf.toString("base64"),
    contentType: res.headers.get("content-type"),
    amount: opts.amount,
    asset: opts.asset,
    network: opts.network,
    txRef: opts.txRef,
    expiresAt: opts.now() + opts.ttlMs,
  };
}
