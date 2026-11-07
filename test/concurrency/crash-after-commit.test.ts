import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, wagerBody } from "../helpers/app";
import { waitFor } from "../helpers/locks";
import { spawnApp } from "../helpers/spawn";
import { createTestQueues, queueDepth, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

let db: TestDb;
let queues: TestQueues;

beforeAll(async () => {
  db = await createTestDb("crash");
  queues = await createTestQueues("crash", { visibilityTimeoutS: 2 });
});
afterAll(async () => {
  await db?.drop();
});

const baseEnv = () => ({
  ...queues.env,
  DATABASE_URL: db.appUrl,
  ENABLE_SQS_CONSUMER: "true",
  ENABLE_OUTBOX_PUBLISHER: "false",
  ENABLE_PENDING_WORKER: "false",
});

async function newWallet(baseUrl: string, amount = "100.00") {
  const playerId = crypto.randomUUID();
  const r = await call(baseUrl, "POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  return { walletId: r.body.id as string, playerId };
}

describe("process killed after COMMIT and before the SQS ack (section 13, test 5)", () => {
  it("the effect is kept, the message comes back, the inbox absorbs it: one debit", async () => {
    const doomed = await spawnApp({ ...baseEnv(), FAILPOINTS: "consumer.after_commit_before_ack=crash" });
    const w = await newWallet(doomed.baseUrl);
    const { key, body } = wagerBody({ ...w, amount: "30.00" });
    const env = requestedEnvelope({ ...body, idempotencyKey: key });
    await sendRaw(queues.urls.main, JSON.stringify(env), w.walletId);

    expect(await doomed.exited).toBe(137); // SIGKILL at the failpoint
    const [tx] = await db.app`select status from wager_transactions where idempotency_key = ${key}`;
    expect(tx.status).toBe("PROCESSED"); // committed before dying
    const [inbox] = await db.app`select count(*)::int as n from inbox_messages where message_id = ${env.messageId}`;
    expect(inbox.n).toBe(1);
    const depth = await queueDepth(queues.urls.main);
    expect(depth.visible + depth.inFlight).toBe(1); // never acked

    const healthy = await spawnApp(baseEnv());
    try {
      await waitFor(async () => {
        const d = await queueDepth(queues.urls.main);
        return d.visible === 0 && d.inFlight === 0;
      }, 15_000);
      await healthy.waitForLine(/"msg":"inbox duplicate"/);
      const [debits] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${w.walletId} and direction = 'DEBIT'`;
      expect(debits.n).toBe(1);
      expect((await call(healthy.baseUrl, "GET", `/wallets/${w.walletId}`)).body.balance.amount).toBe("70.00");
      await expectWalletConsistent(db.app, w.walletId);
    } finally {
      healthy.kill("SIGTERM");
      expect(await healthy.exited).toBe(0);
    }
  });

  it("HTTP: killed after COMMIT and before the response; the provider's retry is a replay", async () => {
    const doomed = await spawnApp({ ...baseEnv(), ENABLE_SQS_CONSUMER: "false", FAILPOINTS: "http.after_commit_before_response=crash" });
    // wallet creation does not hit the failpoint (only the wager path does)
    const w = await newWallet(doomed.baseUrl);
    const { key, body } = wagerBody({ ...w, amount: "25.00" });
    const lost = await call(doomed.baseUrl, "POST", "/wagering/transactions", body, { "Idempotency-Key": key }).catch((e: Error) => e);
    expect(lost).toBeInstanceOf(Error); // connection dropped: the provider does not know the outcome
    expect(await doomed.exited).toBe(137);

    const healthy = await spawnApp({ ...baseEnv(), ENABLE_SQS_CONSUMER: "false" });
    try {
      const retry = await call(healthy.baseUrl, "POST", "/wagering/transactions", body, { "Idempotency-Key": key });
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ idempotentReplay: true, balance: { amount: "75.00" } });
      const [debits] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${w.walletId} and direction = 'DEBIT'`;
      expect(debits.n).toBe(1);
    } finally {
      healthy.kill("SIGTERM");
      await healthy.exited;
    }
  });
});
