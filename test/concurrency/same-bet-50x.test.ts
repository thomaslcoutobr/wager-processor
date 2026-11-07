import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, gate, type RunningApp, startApp, wagerBody } from "../helpers/app";
import { backendsWaitingOnLock, holdWalletLock, waitFor } from "../helpers/locks";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

let db: TestDb;
let running: RunningApp;

beforeAll(async () => {
  db = await createTestDb("same50");
  running = await startApp(db);
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

async function assertSingleDebit(walletId: string, responses: Array<{ status: number; body: any }>) {
  expect(responses.every((r) => r.status === 200)).toBe(true);
  const ids = new Set(responses.map((r) => r.body.transactionId));
  expect(ids.size).toBe(1);
  expect(responses.filter((r) => r.body.idempotentReplay === false).length).toBe(1);
  expect(responses.every((r) => r.body.balance.amount === "75.00")).toBe(true);
  const [d] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
  expect(d.n).toBe(1);
  const [t] = await db.app`select count(*)::int as n from wager_transactions where wallet_id = ${walletId} and kind = 'BET'`;
  expect(t.n).toBe(1);
  const w = (await call(running.baseUrl, "GET", `/wallets/${walletId}`)).body;
  expect(w.balance.amount).toBe("75.00");
  await expectWalletConsistent(db.app, walletId);
}

describe("the same bet sent 50 times in parallel", () => {
  it("produces exactly one debit (5 rounds)", async () => {
    for (let round = 0; round < 5; round++) {
      const playerId = crypto.randomUUID();
      const walletId = await createWallet(running.baseUrl, "100.00", playerId);
      const req = wagerBody({ walletId, playerId, amount: "25.00" });
      const g = gate();
      const all = Array.from({ length: 50 }, async () => {
        await g.wait;
        return call(running.baseUrl, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
      });
      g.open();
      await assertSingleDebit(walletId, await Promise.all(all));
    }
  });

  it("produces exactly one debit when all 50 queue on the row lock", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);
    const req = wagerBody({ walletId, playerId, amount: "25.00" });
    const lock = await holdWalletLock(db.owner, walletId);
    const all = Array.from({ length: 50 }, () =>
      call(running.baseUrl, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key }),
    );
    // the pool caps how many can wait inside Postgres; the rest wait for a connection
    await waitFor(async () => (await backendsWaitingOnLock(db.owner)) >= 2);
    await lock.release();
    await assertSingleDebit(walletId, await Promise.all(all));
  });

  it("same key racing on two different wallets: one applies, the other is a 409 (never a 500)", async () => {
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    const w1 = await createWallet(running.baseUrl, "100.00", p1);
    const w2 = await createWallet(running.baseUrl, "100.00", p2);
    for (let round = 0; round < 10; round++) {
      const key = `race-${crypto.randomUUID()}`;
      const a = wagerBody({ walletId: w1, playerId: p1, externalTransactionId: `${key}-a`, idempotencyKey: key });
      const b = wagerBody({ walletId: w2, playerId: p2, externalTransactionId: `${key}-b`, idempotencyKey: key });
      const g = gate();
      const both = [a, b].map(async (x) => {
        await g.wait;
        return call(running.baseUrl, "POST", "/wagering/transactions", x.body, { "Idempotency-Key": key });
      });
      g.open();
      const res = await Promise.all(both);
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(res.find((r) => r.status === 409)!.body.code).toBe("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
    }
    await expectWalletConsistent(db.app, w1);
    await expectWalletConsistent(db.app, w2);
  });
});
