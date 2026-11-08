import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, type RunningApp, startApp, wagerBody } from "../helpers/app";
import { waitFor } from "../helpers/locks";
import { createTestQueues, receiveAll, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

// Lb-02: with Postgres down, every receive of a message counts towards the redrive limit. Before,
// a message spent its 5 receives in ~15 s of backoff and went to the DLQ; ARCHITECTURE §16 promises
// that the consumer "comes back by itself". Now a DATABASE_UNAVAILABLE pauses the receive loops until
// the database answers again, so the messages wait in the queue without spending their attempts.
let db: TestDb;
let queues: TestQueues;
let running: RunningApp;

beforeAll(async () => {
  db = await createTestDb("dbout");
  queues = await createTestQueues("dbout", { visibilityTimeoutS: 30, maxReceiveCount: 5 });
  running = await startApp(db, {
    env: { ...queues.env, ENABLE_SQS_CONSUMER: "true", SQS_RETRY_BASE_MS: "1000", SQS_RETRY_MAX_MS: "30000" },
  });
});
afterAll(async () => {
  await db?.owner.unsafe(`alter database "${db.name}" connection limit -1`).catch(() => {});
  await running?.close();
  await db?.drop();
});

const pausedGauge = async () => {
  const m = (await (await fetch(`${running.baseUrl}/metrics`)).text()).match(/^sqs_consumer_paused (\d+)/m);
  return m ? Number(m[1]) : -1;
};

/** The app role can no longer connect (53300) and its open connections are cut (57P01). */
async function takeDatabaseDown(): Promise<void> {
  await db.owner.unsafe(`alter database "${db.name}" connection limit 0`);
  await db.owner`select pg_terminate_backend(pid) from pg_stat_activity
                 where datname = current_database() and usename = 'wager_app'`;
}

describe("Postgres outage on the queue path", () => {
  it("a message received while the database is down for 20 s is applied once it is back, not dead-lettered", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);
    const { key, body } = wagerBody({ walletId, playerId, amount: "10.00" });

    await takeDatabaseDown();
    await sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope({ ...body, idempotencyKey: key })), walletId);
    await new Promise((r) => setTimeout(r, 20_000));
    expect(await pausedGauge()).toBe(1); // the pause is visible to the operator
    await db.owner.unsafe(`alter database "${db.name}" connection limit -1`);

    let balance = "";
    await waitFor(async () => {
      const r = await call(running.baseUrl, "GET", `/wallets/${walletId}`).catch(() => undefined);
      balance = r?.body?.balance?.amount ?? "";
      return balance === "90.00";
    }, 15_000).catch(() => {});
    expect(balance).toBe("90.00");
    expect(await receiveAll(queues.urls.dlq, { waitS: 1 })).toHaveLength(0);
    expect(await pausedGauge()).toBe(0);
  }, 90_000);
});
