import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, gate, postWager, type RunningApp, startApp, TestClock, wagerBody } from "../helpers/app";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

let db: TestDb;
let clock: TestClock;
let running: RunningApp;
let base: string;

const TTL_MS = 600_000;

beforeAll(async () => {
  db = await createTestDb("ooo");
  clock = new TestClock(new Date("2026-11-08T10:00:00.000Z"));
  running = await startApp(db, { clock });
  base = running.baseUrl;
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

async function setup(amount = "100.00") {
  const playerId = crypto.randomUUID();
  const walletId = await createWallet(base, amount, playerId);
  return { walletId, playerId };
}
const ext = (p: string) => `${p}-${crypto.randomUUID()}`;
const balanceOf = async (walletId: string) => (await call(base, "GET", `/wallets/${walletId}`)).body.balance.amount as string;
const view = async (id: string) => (await call(base, "GET", `/wagering/transactions/${id}`)).body;
const work = () => running.container.pendingWorker.runOnce();

describe("REFUND/ROLLBACK delivered before their reference (section 13, test 7)", () => {
  it("waits as PENDING_REFERENCE (202), then the BET arrives and the worker applies it", async () => {
    const w = await setup();
    const betId = ext("bet");
    const refundReq = wagerBody({ ...w, kind: "REFUND", amount: "25.00", referenceExternalTransactionId: betId });
    const refund = await call(base, "POST", "/wagering/transactions", refundReq.body, { "Idempotency-Key": refundReq.key });
    expect(refund.status).toBe(202);
    expect(refund.body).toMatchObject({ status: "PENDING_REFERENCE", retry: "POLL", idempotentReplay: false });
    expect(refund.headers.get("location")).toBe(`/wagering/transactions/${refund.body.transactionId}`);
    expect(await balanceOf(w.walletId)).toBe("100.00");
    const [ev] = await db.app`select count(*)::int as n from outbox_messages
                               where aggregate_id = ${refund.body.transactionId} and event_type = 'WagerTransactionPendingReference'`;
    expect(ev.n).toBe(1);

    // replaying while pending returns the CURRENT state
    const replayPending = await call(base, "POST", "/wagering/transactions", refundReq.body, { "Idempotency-Key": refundReq.key });
    expect(replayPending.status).toBe(202);
    expect(replayPending.body.idempotentReplay).toBe(true);

    const bet = await postWager(base, { ...w, externalTransactionId: betId, amount: "25.00" });
    expect(bet.status).toBe(200);
    expect(bet.body.balance.amount).toBe("75.00");
    // the BET nudged the pending refund: it is due now, without waiting for its backoff
    const [due] = await db.app`select next_attempt_at <= ${clock.now()} as due from wager_transactions where id = ${refund.body.transactionId}`;
    expect(due.due).toBe(true);

    await work();
    const after = await view(refund.body.transactionId);
    expect(after).toMatchObject({ status: "PROCESSED", referenceTransactionId: bet.body.transactionId });
    expect(await balanceOf(w.walletId)).toBe("100.00");

    const replayDone = await call(base, "POST", "/wagering/transactions", refundReq.body, { "Idempotency-Key": refundReq.key });
    expect(replayDone.status).toBe(200);
    expect(replayDone.body).toMatchObject({ status: "PROCESSED", idempotentReplay: true, balance: { amount: "100.00" } });
    await expectWalletConsistent(db.app, w.walletId);
  });

  it("retries with backoff while the reference is missing (not due again right away)", async () => {
    const w = await setup();
    const r = await postWager(base, { ...w, kind: "ROLLBACK", amount: "5.00", referenceExternalTransactionId: ext("never") });
    expect(r.status).toBe(202);
    clock.advance(1_000);
    await work();
    let v = await view(r.body.transactionId);
    expect(v.status).toBe("PENDING_REFERENCE");
    expect(v.attempts).toBe(1);
    expect(new Date(v.nextAttemptAt).getTime()).toBeGreaterThan(clock.now().getTime());
    await work(); // not due yet: nothing changes
    v = await view(r.body.transactionId);
    expect(v.attempts).toBe(1);
  });

  it("is REJECTED REFERENCE_NOT_FOUND with an event once the TTL expires", async () => {
    const w = await setup();
    const req = wagerBody({ ...w, kind: "REFUND", amount: "5.00", referenceExternalTransactionId: ext("never") });
    const r = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    expect(r.status).toBe(202);
    clock.advance(TTL_MS - 5_000);
    await work();
    expect((await view(r.body.transactionId)).status).toBe("PENDING_REFERENCE");
    clock.advance(10_000);
    await work();
    const v = await view(r.body.transactionId);
    expect(v).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_NOT_FOUND" });
    const [ev] = await db.app`select count(*)::int as n from outbox_messages
                               where aggregate_id = ${r.body.transactionId} and event_type = 'WagerTransactionRejected'`;
    expect(ev.n).toBe(1);
    const replay = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    expect(replay.status).toBe(422);
    expect(replay.body.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(await balanceOf(w.walletId)).toBe("100.00");
  });

  it("a chain resolves in order: ROLLBACK of a pending REFUND of a missing BET", async () => {
    const w = await setup();
    const betId = ext("bet");
    const refundId = ext("refund");
    const refund = await postWager(base, { ...w, kind: "REFUND", externalTransactionId: refundId, amount: "25.00", referenceExternalTransactionId: betId });
    const rollback = await postWager(base, { ...w, kind: "ROLLBACK", amount: "25.00", referenceExternalTransactionId: refundId });
    expect([refund.status, rollback.status]).toEqual([202, 202]);
    await postWager(base, { ...w, externalTransactionId: betId, amount: "25.00" }); // 75
    await work(); // refund processed (100) and the rollback nudged
    await work(); // rollback processed (75)
    expect((await view(refund.body.transactionId)).status).toBe("PROCESSED");
    expect((await view(rollback.body.transactionId)).status).toBe("PROCESSED");
    expect(await balanceOf(w.walletId)).toBe("75.00");
    await expectWalletConsistent(db.app, w.walletId);
  });

  it("a pending reversal of a BET that ends REJECTED is rejected as REFERENCE_NOT_PROCESSED", async () => {
    const w = await setup("1.00");
    const betId = ext("bet");
    const refund = await postWager(base, { ...w, kind: "REFUND", amount: "50.00", referenceExternalTransactionId: betId });
    expect(refund.status).toBe(202);
    const bet = await postWager(base, { ...w, externalTransactionId: betId, amount: "50.00" });
    expect(bet.status).toBe(422);
    await work();
    expect(await view(refund.body.transactionId)).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_NOT_PROCESSED" });
    expect(await balanceOf(w.walletId)).toBe("1.00");
  });

  it("reversal and reference racing: the reversal is applied exactly once (10 rounds)", async () => {
    for (let round = 0; round < 10; round++) {
      const w = await setup();
      const betId = ext("bet");
      const g = gate();
      const both = [
        (async () => {
          await g.wait;
          return postWager(base, { ...w, kind: "REFUND", amount: "10.00", referenceExternalTransactionId: betId });
        })(),
        (async () => {
          await g.wait;
          return postWager(base, { ...w, externalTransactionId: betId, amount: "10.00" });
        })(),
      ];
      g.open();
      const [refund] = await Promise.all(both);
      expect([200, 202]).toContain(refund!.status);
      await work();
      expect((await view(refund!.body.transactionId)).status).toBe("PROCESSED");
      expect(await balanceOf(w.walletId)).toBe("100.00");
      await expectWalletConsistent(db.app, w.walletId);
    }
  });

  it("the scheduled worker resolves pending transactions on its own (real clock, background loop)", async () => {
    const live = await startApp(db, { env: { ENABLE_PENDING_WORKER: "true", PENDING_POLL_MS: "50" } });
    try {
      const playerId = crypto.randomUUID();
      const walletId = await createWallet(live.baseUrl, "100.00", playerId);
      const betId = ext("bet");
      const refund = await postWager(live.baseUrl, { walletId, playerId, kind: "REFUND", amount: "10.00", referenceExternalTransactionId: betId });
      expect(refund.status).toBe(202);
      await postWager(live.baseUrl, { walletId, playerId, externalTransactionId: betId, amount: "10.00" });
      const { waitFor } = await import("../helpers/locks");
      await waitFor(async () => (await call(live.baseUrl, "GET", `/wagering/transactions/${refund.body.transactionId}`)).body.status === "PROCESSED", 5_000);
      expect((await call(live.baseUrl, "GET", `/wallets/${walletId}`)).body.balance.amount).toBe("100.00");
    } finally {
      await live.close();
    }
  });

  it("two workers on the same due pending transaction apply it once", async () => {
    const second = await startApp(db, { clock });
    try {
      for (let round = 0; round < 5; round++) {
        const w = await setup();
        const betId = ext("bet");
        const refund = await postWager(base, { ...w, kind: "REFUND", amount: "10.00", referenceExternalTransactionId: betId });
        await postWager(base, { ...w, externalTransactionId: betId, amount: "10.00" });
        await Promise.all([work(), second.container.pendingWorker.runOnce(), work()]);
        expect((await view(refund.body.transactionId)).status).toBe("PROCESSED");
        const [credits] = await db.app`select count(*)::int as n from wallet_ledger_entries
                                        where transaction_id = ${refund.body.transactionId}`;
        expect(credits.n).toBe(1);
        expect(await balanceOf(w.walletId)).toBe("100.00");
      }
    } finally {
      await second.close();
    }
  });
});

describe("the reference is resolved only inside the same providerId (section 7, rule 2)", () => {
  it("another provider's transaction with the same external id is never taken as the reference", async () => {
    const w = await setup();
    const sharedId = ext("shared");
    const betA = await postWager(base, { ...w, providerId: "provider-a", externalTransactionId: sharedId, amount: "25.00" });
    expect(betA.status).toBe(200);

    // provider-b reverses "its" bet sharedId, which it has not sent yet: it must wait, not undo provider-a's bet
    const refundB = await postWager(base, {
      ...w,
      providerId: "provider-b",
      kind: "REFUND",
      amount: "25.00",
      referenceExternalTransactionId: sharedId,
    });
    expect(refundB.status).toBe(202);
    expect(refundB.body.status).toBe("PENDING_REFERENCE");
    expect(await balanceOf(w.walletId)).toBe("75.00");

    // the worker's retry looks in the same scope: still pending after a due attempt
    clock.advance(60_000);
    await work();
    const retried = await view(refundB.body.transactionId);
    expect(retried.status).toBe("PENDING_REFERENCE");
    expect(retried.attempts).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(w.walletId)).toBe("75.00");

    // provider-b's own bet arrives: that one is the reference
    const betB = await postWager(base, { ...w, providerId: "provider-b", externalTransactionId: sharedId, amount: "25.00" });
    expect(betB.status).toBe(200);
    await work();
    expect(await view(refundB.body.transactionId)).toMatchObject({
      status: "PROCESSED",
      referenceTransactionId: betB.body.transactionId,
    });
    expect(await balanceOf(w.walletId)).toBe("75.00");

    // provider-a's bet was never reversed: its own refund still applies
    const refundA = await postWager(base, {
      ...w,
      providerId: "provider-a",
      kind: "REFUND",
      amount: "25.00",
      referenceExternalTransactionId: sharedId,
    });
    expect(refundA.status).toBe(200);
    expect(refundA.body.balance.amount).toBe("100.00");
    expect((await view(refundA.body.transactionId)).referenceTransactionId).toBe(betA.body.transactionId);
    await expectWalletConsistent(db.app, w.walletId);
  });
});
