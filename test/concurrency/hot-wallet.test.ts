import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, gate, postWager, type RunningApp, startApp } from "../helpers/app";
import { backendsWaitingOnLock, holdWalletLock, waitFor } from "../helpers/locks";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

let db: TestDb;
let running: RunningApp;

beforeAll(async () => {
  db = await createTestDb("hot");
  running = await startApp(db, { env: { LOCK_TIMEOUT_MS: "5000" } });
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

async function assertScenario(walletId: string, statuses: number[]) {
  expect(statuses.sort()).toEqual([200, 422]);
  const w = (await call(running.baseUrl, "GET", `/wallets/${walletId}`)).body;
  expect(w.balance).toEqual({ amount: "20.00", currency: "BRL" });
  expect(w.version).toBe(2);
  const [debits] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
  expect(debits.n).toBe(1);
  const rows = await db.app`select status, failure_code from wager_transactions where wallet_id = ${walletId} and kind = 'BET' order by status`;
  expect(rows).toEqual([
    { status: "PROCESSED", failure_code: null },
    { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" },
  ]);
  await expectWalletConsistent(db.app, walletId);
}

describe("section 8 scenario: 100.00 and two simultaneous bets of 80.00", () => {
  it("one PROCESSED, one REJECTED INSUFFICIENT_FUNDS, balance 20.00, one debit (20 rounds)", async () => {
    for (let round = 0; round < 20; round++) {
      const playerId = crypto.randomUUID();
      const walletId = await createWallet(running.baseUrl, "100.00", playerId);
      const g = gate();
      const reqs = [0, 1].map(async () => {
        await g.wait;
        return postWager(running.baseUrl, { walletId, playerId, amount: "80.00" });
      });
      g.open();
      const res = await Promise.all(reqs);
      await assertScenario(walletId, res.map((r) => r.status));
    }
  });

  it("holds even when both requests are forced to wait on the same row lock", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);
    const lock = await holdWalletLock(db.owner, walletId);
    const reqs = [0, 1].map(() => postWager(running.baseUrl, { walletId, playerId, amount: "80.00" }));
    await waitFor(async () => (await backendsWaitingOnLock(db.owner)) >= 2);
    await lock.release();
    const res = await Promise.all(reqs);
    await assertScenario(walletId, res.map((r) => r.status));
  });

  it("retrying both requests does not duplicate the debit", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);
    const a = { walletId, playerId, amount: "80.00", externalTransactionId: `a-${crypto.randomUUID()}` };
    const b = { walletId, playerId, amount: "80.00", externalTransactionId: `b-${crypto.randomUUID()}` };
    const first = await Promise.all([postWager(running.baseUrl, a), postWager(running.baseUrl, b)]);
    const retried = await Promise.all([postWager(running.baseUrl, a), postWager(running.baseUrl, b), postWager(running.baseUrl, a)]);
    expect(retried.every((r) => r.body.idempotentReplay === true)).toBe(true);
    expect(retried[0]!.status).toBe(first[0]!.status);
    expect(retried[1]!.status).toBe(first[1]!.status);
    await assertScenario(walletId, first.map((r) => r.status));
  });
});

describe("lock timeout is transient", () => {
  it("a wallet locked longer than lock_timeout gives 503 + Retry-After and records nothing", async () => {
    const short = await startApp(db, { env: { LOCK_TIMEOUT_MS: "300" } });
    try {
      const playerId = crypto.randomUUID();
      const walletId = await createWallet(short.baseUrl, "100.00", playerId);
      const lock = await holdWalletLock(db.owner, walletId);
      const ext = `lt-${crypto.randomUUID()}`;
      let r;
      try {
        r = await postWager(short.baseUrl, { walletId, playerId, externalTransactionId: ext });
      } finally {
        await lock.release();
      }
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("LOCK_TIMEOUT");
      expect(r.headers.get("retry-after")).toBeTruthy();
      const [n] = await db.app`select count(*)::int as n from wager_transactions where external_transaction_id = ${ext}`;
      expect(n.n).toBe(0);
      const again = await postWager(short.baseUrl, { walletId, playerId, externalTransactionId: ext });
      expect(again.status).toBe(200);
      expect(again.body.idempotentReplay).toBe(false);
    } finally {
      await short.close();
    }
  });
});
