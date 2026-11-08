import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, type RunningApp, startApp, wagerBody } from "../helpers/app";
import { waitFor } from "../helpers/locks";
import { createTestQueues, queueDepth, receiveAll, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

let db: TestDb;
let queues: TestQueues;
let running: RunningApp;
let base: string;

beforeAll(async () => {
  db = await createTestDb("sqsinbox");
  queues = await createTestQueues("inbox");
  running = await startApp(db, { env: { ...queues.env, ENABLE_SQS_CONSUMER: "true" } });
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

/** A queue message for this wager (data carries the idempotency key, as in the challenge). */
function message(w: { walletId: string; playerId: string }, over: Record<string, string> = {}) {
  const { key, body } = wagerBody({ ...w, ...over });
  return { key, body, data: { ...body, idempotencyKey: key } };
}

async function byExternal(externalId: string) {
  return call(base, "GET", `/providers/provider-a/wagering/transactions/${externalId}`);
}

async function waitProcessed(externalId: string) {
  await waitFor(async () => (await byExternal(externalId)).status === 200, 10_000);
  return (await byExternal(externalId)).body;
}

async function dlqReasons(): Promise<string[]> {
  const msgs = await receiveAll(queues.urls.dlq, { waitS: 1 });
  return msgs.map((m) => m.MessageAttributes?.failureReason?.StringValue ?? "?");
}

async function waitQueueEmpty() {
  await waitFor(async () => {
    const d = await queueDepth(queues.urls.main);
    return d.visible === 0 && d.inFlight === 0;
  }, 10_000);
}

describe("SQS consumer", () => {
  it("applies a queued wager through the same use case, records the inbox and acks after commit", async () => {
    const w = await setup();
    const m = message(w, { amount: "30.00" });
    const env = requestedEnvelope(m.data);
    await sendRaw(queues.urls.main, JSON.stringify(env), w.walletId);
    const tx = await waitProcessed(m.body.externalTransactionId);
    expect(tx).toMatchObject({ status: "PROCESSED", kind: "BET" });
    const [inbox] = await db.app`select payload_hash, processed_at is not null as done from inbox_messages where message_id = ${env.messageId}`;
    expect(inbox.done).toBe(true);
    await waitQueueEmpty();
    expect((await call(base, "GET", `/wallets/${w.walletId}`)).body.balance.amount).toBe("70.00");
    const [ev] = await db.app`select count(*)::int as n from outbox_messages where aggregate_id = ${tx.transactionId}`;
    expect(ev.n).toBe(1);
  });

  it("a redelivered message (same messageId, new SQS dedup id) is acked by the inbox without a second effect", async () => {
    const w = await setup();
    const m = message(w, { amount: "10.00" });
    const env = requestedEnvelope(m.data);
    await sendRaw(queues.urls.main, JSON.stringify(env), w.walletId);
    await waitProcessed(m.body.externalTransactionId);
    await sendRaw(queues.urls.main, JSON.stringify(env), w.walletId); // FIFO does not hide it: other dedup id
    await waitQueueEmpty();
    const [debits] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${w.walletId} and direction = 'DEBIT'`;
    expect(debits.n).toBe(1);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(/wager_duplicates_total\{source="sqs",kind="inbox"\} [1-9]/);
    await expectWalletConsistent(db.app, w.walletId);
  });

  it("the same operation via HTTP and via SQS hashes the same: the second is a replay", async () => {
    const w = await setup();
    const m = message(w, { amount: "15.00" });
    const http = await call(base, "POST", "/wagering/transactions", m.body, { "Idempotency-Key": m.key });
    expect(http.status).toBe(200);
    await sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope(m.data)), w.walletId);
    await waitQueueEmpty();
    expect((await call(base, "GET", `/wallets/${w.walletId}`)).body.balance.amount).toBe("85.00");
  });

  it("a business rejection is terminal: recorded REJECTED and acked (not DLQ)", async () => {
    const w = await setup("5.00");
    const m = message(w, { amount: "50.00" });
    await sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope(m.data)), w.walletId);
    const tx = await waitProcessed(m.body.externalTransactionId);
    expect(tx).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
    await waitQueueEmpty();
  });

  it("permanent errors go to the DLQ with the reason: invalid JSON, unknown type, invalid payload, unknown wallet, messageId reused", async () => {
    const w = await setup();
    await sendRaw(queues.urls.main, "{not json", "g-1");
    await sendRaw(queues.urls.main, JSON.stringify({ messageId: "x-1", type: "SomethingElse", data: {} }), "g-2");
    const bad = message(w);
    await sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope({ ...bad.data, money: { amount: "1e3", currency: "BRL" } })), w.walletId);
    const ghost = message({ walletId: crypto.randomUUID(), playerId: "p" });
    await sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope(ghost.data)), "g-3");
    const first = message(w, { amount: "1.00" });
    const env = requestedEnvelope(first.data);
    await sendRaw(queues.urls.main, JSON.stringify(env), w.walletId);
    await waitProcessed(first.body.externalTransactionId);
    const other = message(w, { amount: "2.00" });
    await sendRaw(queues.urls.main, JSON.stringify({ ...env, data: other.data }), w.walletId); // same messageId, other payload

    await waitQueueEmpty();
    const reasons: string[] = [];
    await waitFor(async () => {
      reasons.push(...(await dlqReasons()));
      return reasons.length >= 5;
    }, 10_000);
    expect(reasons.sort()).toEqual(["INVALID_AMOUNT", "INVALID_JSON", "MESSAGE_ID_PAYLOAD_MISMATCH", "UNKNOWN_MESSAGE_TYPE", "WALLET_NOT_FOUND"]);
    expect((await call(base, "GET", `/wallets/${w.walletId}`)).body.balance.amount).toBe("99.00");
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(/sqs_dlq_total\{reason="INVALID_JSON"\} 1/);
  });

  it("a REFUND queued before its BET waits as PENDING_REFERENCE (acked, not retried), then applies once the BET arrives by the queue", async () => {
    const w = await setup();
    const betId = `bet-${crypto.randomUUID()}`;
    const refund = message(w, { kind: "REFUND", amount: "25.00", referenceExternalTransactionId: betId });
    await sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope(refund.data)), w.walletId);
    const pending = await waitProcessed(refund.body.externalTransactionId);
    expect(pending.status).toBe("PENDING_REFERENCE");
    await waitQueueEmpty(); // acked: the wait lives in the database, not in redeliveries
    expect((await call(base, "GET", `/wallets/${w.walletId}`)).body.balance.amount).toBe("100.00");

    const bet = message(w, { externalTransactionId: betId, amount: "25.00" });
    await sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope(bet.data)), w.walletId);
    const betTx = await waitProcessed(betId);
    expect(betTx.status).toBe("PROCESSED");
    expect((await call(base, "GET", `/wallets/${w.walletId}`)).body.balance.amount).toBe("75.00");

    await running.container.pendingWorker.runOnce(); // the BET nudged it: due now
    const done = (await byExternal(refund.body.externalTransactionId)).body;
    expect(done).toMatchObject({ status: "PROCESSED", referenceTransactionId: betTx.transactionId });
    expect((await call(base, "GET", `/wallets/${w.walletId}`)).body.balance.amount).toBe("100.00");
    expect(await dlqReasons()).toEqual([]);
    await expectWalletConsistent(db.app, w.walletId);
  });
});
