import { describe, expect, it } from "bun:test";
import { call, createWallet, postWager, startApp } from "../helpers/app";
import { holdWalletLock } from "../helpers/locks";
import { createTestDb } from "../helpers/test-db";

// R2b-01: the same as pending-backoff.test.ts, with a REAL clock. When the worker backed off one
// candidate at a time, each busy candidate cost one lock_timeout, the pass outlasted the back-off,
// and a busy wallet with more pendings than the batch filled every batch again: the reversal of
// another wallet never got in. Small scale: lock_timeout 200 ms, back-off cap 400 ms, batch 4.
const ext = (p: string) => `${p}-${crypto.randomUUID()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Final status of the other wallet's pending reversal after `budgetMs` of passes with W1 locked. */
async function scenario(label: string, w1Pendings: number, budgetMs: number) {
  const db = await createTestDb(label);
  const running = await startApp(db, {
    env: { LOCK_TIMEOUT_MS: "200", PENDING_BATCH_SIZE: "4", PENDING_REFERENCE_BASE_DELAY_MS: "100", PENDING_REFERENCE_MAX_DELAY_MS: "400" },
  });
  const status = async (id: string) => (await call(running.baseUrl, "GET", `/wagering/transactions/${id}`)).body.status as string;
  try {
    const p1 = crypto.randomUUID();
    const w1 = await createWallet(running.baseUrl, "100.00", p1);
    for (let i = 0; i < w1Pendings; i++) {
      const r = await postWager(running.baseUrl, { walletId: w1, playerId: p1, kind: "REFUND", amount: "1.00", referenceExternalTransactionId: ext("never") });
      expect(r.status).toBe(202);
    }
    await sleep(300); // the W1 pendings become due (base delay 100 ms × jitter)

    // the reversal of W2 arrives before its BET; the BET nudges it to "due now", after every W1 pending
    const p2 = crypto.randomUUID();
    const w2 = await createWallet(running.baseUrl, "100.00", p2);
    const betId = ext("bet");
    const refund = await postWager(running.baseUrl, { walletId: w2, playerId: p2, kind: "REFUND", amount: "10.00", referenceExternalTransactionId: betId });
    expect(refund.status).toBe(202);
    expect((await postWager(running.baseUrl, { walletId: w2, playerId: p2, amount: "10.00", externalTransactionId: betId })).status).toBe(200);

    const lock = await holdWalletLock(db.owner, w1);
    try {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline) {
        await running.container.pendingWorker.runOnce();
        if ((await status(refund.body.transactionId)) === "PROCESSED") break;
      }
    } finally {
      await lock.release();
    }
    return await status(refund.body.transactionId);
  } finally {
    await running.close();
    await db.drop();
  }
}

describe("pending worker under a busy wallet, real clock", () => {
  it("a busy wallet with more pendings than the batch does not keep another wallet's reversal out", async () => {
    expect(await scenario("pendreal_many", 10, 10_000)).toBe("PROCESSED");
  }, 60_000);

  it("control: with fewer pendings than the batch, the reversal gets in too", async () => {
    expect(await scenario("pendreal_few", 2, 10_000)).toBe("PROCESSED");
  }, 60_000);
});
