import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { createWallet, postWager, type RunningApp, startApp } from "../helpers/app";
import { createTestDb, type TestDb } from "../helpers/test-db";

// The suite-wide invariant (balance == ledger, no hole in the chain) is checked by every test
// database on drop(). These tests prove the check itself catches a divergence.

let db: TestDb;
let running: RunningApp;
let base: string;

beforeAll(async () => {
  db = await createTestDb("invariant");
  running = await startApp(db);
  base = running.baseUrl;
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

async function tamperBalance(target: TestDb, walletId: string, balance: string): Promise<void> {
  await target.owner.unsafe(`alter table wallets disable trigger wallet_change_is_backed`);
  try {
    await target.owner`update wallets set balance = ${balance}::numeric where id = ${walletId}`;
  } finally {
    await target.owner.unsafe(`alter table wallets enable trigger wallet_change_is_backed`);
  }
}

describe("suite-wide invariant on every test database", () => {
  it("passes on wallets moved only by the application", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(base, "100.00", playerId);
    await postWager(base, { walletId, playerId, amount: "10.00" });
    await postWager(base, { walletId, playerId, kind: "WIN", amount: "4.50" });
    await db.checkInvariant();
  });

  it("fails naming the wallet whose stored balance diverges from the ledger", async () => {
    const walletId = await createWallet(base, "50.00");
    await tamperBalance(db, walletId, "70.00");
    const error = await db.checkInvariant().then(() => undefined, (e: Error) => e);
    expect(error?.message).toContain(walletId);
    expect(error?.message).toContain("balance");
    db.excludeFromInvariant(walletId);
    await db.checkInvariant();
  });

  it("fails on a hole in the before/after chain even when the sum still matches", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(base, "30.00", playerId);
    await postWager(base, { walletId, playerId, amount: "5.00" });
    await db.owner.unsafe(`alter table wallet_ledger_entries disable trigger user`);
    try {
      await db.owner`update wallet_ledger_entries set balance_before = balance_before + 1, balance_after = balance_after + 1
                      where wallet_id = ${walletId} and wallet_version = 2`;
    } finally {
      await db.owner.unsafe(`alter table wallet_ledger_entries enable trigger user`);
    }
    const error = await db.checkInvariant().then(() => undefined, (e: Error) => e);
    expect(error?.message).toContain(walletId);
    expect(error?.message).toContain("chain");
    db.excludeFromInvariant(walletId);
    await db.checkInvariant();
  });

  it("drop() rejects on a divergence and still removes the database", async () => {
    const other = await createTestDb("invariant_drop");
    const app = await startApp(other);
    let walletId: string;
    try {
      walletId = await createWallet(app.baseUrl, "20.00");
    } finally {
      await app.close();
    }
    await tamperBalance(other, walletId, "21.00");
    const error = await other.drop().then(() => undefined, (e: Error) => e);
    expect(error?.message).toContain(walletId);
    const admin = new SQL(process.env.DATABASE_ADMIN_URL!);
    try {
      const [row] = await admin`select count(*)::int as n from pg_database where datname = ${other.name}`;
      expect(row.n).toBe(0);
    } finally {
      await admin.close();
    }
  });

  it("drop() of a database without the schema does not fail", async () => {
    const bare = await createTestDb("invariant_bare", { migrate: false });
    await bare.drop();
  });
});
