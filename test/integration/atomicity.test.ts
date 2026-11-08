import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, type RunningApp, startApp, wagerBody } from "../helpers/app";
import { waitFor } from "../helpers/locks";
import { createTestQueues, queueDepth, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

// ARCHITECTURE §9/§19: transaction, balance, ledger, inbox and outbox are written in ONE database
// transaction. A failure after every write and before COMMIT must leave no trace in any of them.
let db: TestDb;
let queues: TestQueues;
let running: RunningApp;

beforeAll(async () => {
  db = await createTestDb("atomic");
  queues = await createTestQueues("atomic", { visibilityTimeoutS: 2, maxReceiveCount: 5 });
  running = await startApp(db, { env: { ...queues.env, ENABLE_SQS_CONSUMER: "true" } });
});
afterAll(async () => {
  running?.failpoints.clear();
  await running?.close();
  await db?.drop();
});

async function footprint(walletId: string, key: string, messageId?: string) {
  const [w] = await db.app`select balance::text as balance, version from wallets where id = ${walletId}`;
  const [t] = await db.app`select count(*)::int as n from wager_transactions where idempotency_key = ${key}`;
  const [l] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId}`;
  const [o] = await db.app`select count(*)::int as n from outbox_messages where message_group_id = ${walletId}`;
  const [i] = messageId ? await db.app`select count(*)::int as n from inbox_messages where message_id = ${messageId}` : [{ n: 0 }];
  return { balance: w.balance, version: w.version, transactions: t.n, ledger: l.n, outbox: o.n, inbox: i.n };
}

describe("one database transaction per decision", () => {
  it("HTTP: a failure right before COMMIT leaves balance, ledger, transaction and outbox untouched; the retry applies once", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);
    const { key, body } = wagerBody({ walletId, playerId, amount: "30.00" });
    const before = await footprint(walletId, key);

    running.failpoints.set("usecase.before_commit", "transient");
    const r = await call(running.baseUrl, "POST", "/wagering/transactions", body, { "Idempotency-Key": key });
    running.failpoints.clear();
    expect(r.status).toBe(503);
    expect(await footprint(walletId, key)).toEqual(before);

    const retry = await call(running.baseUrl, "POST", "/wagering/transactions", body, { "Idempotency-Key": key });
    expect(retry.status).toBe(200);
    expect(await footprint(walletId, key)).toEqual({
      balance: "70.00",
      version: before.version + 1,
      transactions: 1,
      ledger: before.ledger + 1,
      outbox: before.outbox + 2, // WagerTransactionProcessed + WalletBalanceChanged
      inbox: 0,
    });
    await expectWalletConsistent(db.app, walletId);
  });

  it("queue: the same failure also rolls back the inbox row, so the redelivery is processed (not taken as a duplicate)", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);
    const { key, body } = wagerBody({ walletId, playerId, amount: "30.00" });
    const env = requestedEnvelope({ ...body, idempotencyKey: key });
    const before = await footprint(walletId, key, env.messageId);

    running.failpoints.set("usecase.before_commit", "transient");
    await sendRaw(queues.urls.main, JSON.stringify(env), walletId);
    await waitFor(async () => /sqs_retries_total [1-9]/.test(await (await fetch(`${running.baseUrl}/metrics`)).text()), 10_000);
    expect(await footprint(walletId, key, env.messageId)).toEqual(before);
    running.failpoints.clear();

    await waitFor(async () => (await footprint(walletId, key, env.messageId)).balance === "70.00", 15_000);
    await waitFor(async () => {
      const d = await queueDepth(queues.urls.main);
      return d.visible === 0 && d.inFlight === 0;
    }, 15_000);
    expect(await footprint(walletId, key, env.messageId)).toEqual({
      balance: "70.00",
      version: before.version + 1,
      transactions: 1,
      ledger: before.ledger + 1,
      outbox: before.outbox + 2,
      inbox: 1,
    });
    await expectWalletConsistent(db.app, walletId);
  });
});
