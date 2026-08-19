import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteCacheStore, responseFromCacheEntry, cacheEntryFromResponse } from "../src/cache.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tollgate-cache-"));
  db = new Database(join(dir, "tollgate.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteCacheStore", () => {
  it("round-trips a set entry through get", async () => {
    const store = new SqliteCacheStore(db, () => 1000);
    const entry = {
      status: 200,
      body: Buffer.from("hello").toString("base64"),
      contentType: "application/json",
      amount: "50000",
      asset: "0xasset",
      network: "base-sepolia",
      txRef: "tx-1",
      expiresAt: 5000,
    };
    await store.set("key-1", entry);
    await expect(store.get("key-1")).resolves.toEqual(entry);
  });

  it("returns undefined for a missing key", async () => {
    const store = new SqliteCacheStore(db, () => 1000);
    await expect(store.get("nonexistent")).resolves.toBeUndefined();
  });

  it("returns undefined for an expired entry using the injected clock", async () => {
    let currentTime = 1000;
    const store = new SqliteCacheStore(db, () => currentTime);
    await store.set("key-1", {
      status: 200,
      body: "aGVsbG8=",
      contentType: null,
      amount: "1",
      asset: "USDC",
      network: "base",
      expiresAt: 2000,
    });

    currentTime = 1500;
    await expect(store.get("key-1")).resolves.toBeDefined();

    currentTime = 2500;
    await expect(store.get("key-1")).resolves.toBeUndefined();
  });

  it("overwrites an existing key on a second set", async () => {
    const store = new SqliteCacheStore(db, () => 1000);
    await store.set("key-1", {
      status: 200,
      body: "b25l",
      contentType: null,
      amount: "1",
      asset: "USDC",
      network: "base",
      expiresAt: 9999,
    });
    await store.set("key-1", {
      status: 200,
      body: "dHdv",
      contentType: null,
      amount: "2",
      asset: "USDC",
      network: "base",
      expiresAt: 9999,
    });

    const entry = await store.get("key-1");
    expect(entry?.body).toBe("dHdv");
    expect(entry?.amount).toBe("2");
  });
});

describe("responseFromCacheEntry / cacheEntryFromResponse", () => {
  it("round-trips a Response through cacheEntryFromResponse and back", async () => {
    const original = new Response(JSON.stringify({ hello: "world" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    let currentTime = 1000;
    const entry = await cacheEntryFromResponse(original, {
      amount: "50000",
      asset: "0xasset",
      network: "base-sepolia",
      txRef: "tx-1",
      ttlMs: 3600_000,
      now: () => currentTime,
    });

    expect(entry.expiresAt).toBe(currentTime + 3600_000);

    const reconstructed = responseFromCacheEntry(entry);
    expect(reconstructed.status).toBe(200);
    expect(reconstructed.headers.get("content-type")).toBe("application/json");
    await expect(reconstructed.json()).resolves.toEqual({ hello: "world" });
  });

  it("preserves binary bodies through the base64 round trip", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 253]);
    const original = new Response(bytes, { status: 200 });

    const entry = await cacheEntryFromResponse(original, {
      amount: "1",
      asset: "USDC",
      network: "base",
      ttlMs: 1000,
      now: () => 0,
    });

    const reconstructed = responseFromCacheEntry(entry);
    const buf = Buffer.from(await reconstructed.arrayBuffer());
    expect([...buf]).toEqual([0, 1, 2, 255, 254, 253]);
  });
});
