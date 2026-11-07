import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, type RunningApp, startApp, wagerBody } from "../helpers/app";
import { waitFor } from "../helpers/locks";
import { createTestQueues, queueDepth, receiveAll, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

let db: TestDb;
let queues: TestQueues;
let running: RunningApp;
let base: string;

beforeAll(async () => {
  db = await createTestDb("sqsretry");
  queues = await createTestQueues("retry", { visibilityTimeoutS: 2, maxReceiveCount: 5 });
  running = await startApp(db, { env: { ...queues.env, ENABLE_SQS_CONSUMER: "true" } });
  base = running.baseUrl;
});
afterAll(async () => {
  running?.failpoints.clear();
  await running?.close();
  await db?.drop();
});

const metric = async (re: RegExp) => {
  const m = (await (await fetch(`${base}/metrics`)).text()).match(re);
  return m ? Number(m[1]) : 0;
};

describe("transient failures on the queue path", () => {
  it("are retried with backoff and, at the 5th receive, go to the DLQ as RETRY_LIMIT_EXCEEDED without recording anything; a redrive later applies once", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(base, "100.00", playerId);
    const { key, body } = wagerBody({ walletId, playerId, amount: "40.00" });
    const env = requestedEnvelope({ ...body, idempotencyKey: key });
    running.failpoints.set("usecase.before_commit", "transient");
    await sendRaw(queues.urls.main, JSON.stringify(env), walletId);

    let dead: Awaited<ReturnType<typeof receiveAll>> = [];
    await waitFor(async () => {
      dead = await receiveAll(queues.urls.dlq, { waitS: 1 });
      return dead.length > 0;
    }, 30_000);
    running.failpoints.clear();
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toBe("RETRY_LIMIT_EXCEEDED");
    expect(dead[0]!.MessageAttributes?.receiveCount?.StringValue).toBe("5");
    expect(await metric(/sqs_retries_total (\d+)/)).toBe(4);
    const [n] = await db.app`select count(*)::int as n from wager_transactions where idempotency_key = ${key}`;
    expect(n.n).toBe(0);
    const [inbox] = await db.app`select count(*)::int as n from inbox_messages where message_id = ${env.messageId}`;
    expect(inbox.n).toBe(0);

    // after the incident: redrive the dead message back to the main queue; processing is idempotent
    await sendRaw(queues.urls.main, dead[0]!.Body!, walletId);
    await waitFor(async () => (await call(base, "GET", `/wallets/${walletId}`)).body.balance.amount === "60.00", 10_000);
    await waitFor(async () => {
      const d = await queueDepth(queues.urls.main);
      return d.visible === 0 && d.inFlight === 0;
    }, 10_000);
  });

  it("a failure that clears before the limit is applied once, after retries", async () => {
    const before = await metric(/sqs_retries_total (\d+)/);
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(base, "100.00", playerId);
    const { key, body } = wagerBody({ walletId, playerId, amount: "10.00" });
    running.failpoints.set("usecase.before_commit", "transient");
    await sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope({ ...body, idempotencyKey: key })), walletId);
    await waitFor(async () => (await metric(/sqs_retries_total (\d+)/)) >= before + 2, 20_000);
    running.failpoints.clear();
    await waitFor(async () => (await call(base, "GET", `/wallets/${walletId}`)).body.balance.amount === "90.00", 10_000);
    const [d] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
    expect(d.n).toBe(1);
  });
});
