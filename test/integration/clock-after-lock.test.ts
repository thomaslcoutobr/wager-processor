import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, type RunningApp, startApp, TestClock, wagerBody } from "../helpers/app";
import { backendsWaitingOnLock, holdWalletLock, waitFor } from "../helpers/locks";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

let db: TestDb;
let running: RunningApp;
const clock = new TestClock(new Date("2026-11-09T12:00:00.000Z"));

beforeAll(async () => {
  db = await createTestDb("clock");
  running = await startApp(db, { clock });
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

describe("time of a decision (R1-05)", () => {
  it("is read after the wallet lock, so ledger time never runs behind wallet_version", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);
    const lock = await holdWalletLock(db.owner, walletId);
    const { key, body } = wagerBody({ walletId, playerId, amount: "10.00" });
    const pending = call(running.baseUrl, "POST", "/wagering/transactions", body, { "Idempotency-Key": key });
    await waitFor(async () => (await backendsWaitingOnLock(db.owner)) > 0);

    // while the request waits for the lock, whoever holds it commits later in time
    clock.advance(60_000);
    const decidedAt = clock.now().toISOString();
    await lock.release();
    const r = await pending;
    expect(r.status).toBe(200);

    const [entry] = await db.app`select created_at from wallet_ledger_entries where transaction_id = ${r.body.transactionId}`;
    expect(new Date(entry.created_at).toISOString()).toBe(decidedAt);
    const [tx] = await db.app`select created_at, processed_at from wager_transactions where id = ${r.body.transactionId}`;
    expect(new Date(tx.processed_at).toISOString()).toBe(decidedAt);
    await expectWalletConsistent(db.app, walletId);
  });
});
