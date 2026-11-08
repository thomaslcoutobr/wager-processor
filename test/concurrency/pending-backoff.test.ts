import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, postWager, type RunningApp, startApp, TestClock } from "../helpers/app";
import { holdWalletLock } from "../helpers/locks";
import { createTestDb, type TestDb } from "../helpers/test-db";

// Lb-05: a transient failure of the pending worker (wallet busy, database down) used to leave the
// candidate due, so the same busy candidates came first in every pass and the pending reversals of
// other wallets never made it into the batch. Now a transient failure backs the candidate off
// (exponential, with jitter, per instance) and the pass moves on to the others.
let db: TestDb;
let clock: TestClock;
let running: RunningApp;

beforeAll(async () => {
  db = await createTestDb("pendbackoff");
  clock = new TestClock(new Date("2026-11-08T10:00:00.000Z"));
  running = await startApp(db, { clock, env: { LOCK_TIMEOUT_MS: "200", PENDING_BATCH_SIZE: "20" } });
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

const ext = (p: string) => `${p}-${crypto.randomUUID()}`;
const status = async (id: string) => (await call(running.baseUrl, "GET", `/wagering/transactions/${id}`)).body.status as string;

describe("pending worker under a busy wallet", () => {
  it("backs the busy candidates off, so a due reversal of another wallet is applied in the next pass", async () => {
    const p1 = crypto.randomUUID();
    const w1 = await createWallet(running.baseUrl, "100.00", p1);
    for (let i = 0; i < 20; i++) {
      const r = await postWager(running.baseUrl, { walletId: w1, playerId: p1, kind: "REFUND", amount: "1.00", referenceExternalTransactionId: ext("never") });
      expect(r.status).toBe(202);
    }

    // 10 s later, a REFUND of another wallet arrives before its BET; the BET then nudges it (due now)
    clock.advance(10_000);
    const p2 = crypto.randomUUID();
    const w2 = await createWallet(running.baseUrl, "100.00", p2);
    const betId = ext("bet");
    const refund = await postWager(running.baseUrl, { walletId: w2, playerId: p2, kind: "REFUND", amount: "10.00", referenceExternalTransactionId: betId });
    expect(refund.status).toBe(202);
    expect((await postWager(running.baseUrl, { walletId: w2, playerId: p2, amount: "10.00", externalTransactionId: betId })).status).toBe(200);
    clock.advance(10_000); // the 20 of w1 are due since ~10 s earlier, so they fill the batch first

    const lock = await holdWalletLock(db.owner, w1);
    try {
      const first = await running.container.pendingWorker.runOnce();
      expect(first.error).toBe(20); // all 20 hit lock_timeout
      await running.container.pendingWorker.runOnce();
      await running.container.pendingWorker.runOnce();
      expect(await status(refund.body.transactionId)).toBe("PROCESSED");
    } finally {
      await lock.release();
    }

    // the back-off ends: past it, the 20 are tried again (still waiting for a reference that never comes)
    clock.advance(120_000);
    const again = await running.container.pendingWorker.runOnce();
    expect(again.rescheduled).toBe(20);
  }, 90_000);
});
