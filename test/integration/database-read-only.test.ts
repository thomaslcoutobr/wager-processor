import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, postWager, type RunningApp, startApp, wagerBody } from "../helpers/app";
import { waitFor } from "../helpers/locks";
import { createTestQueues, receiveAll, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

// R2b-03: a Postgres that reads but refuses writes (a failover window) answers 25006. It used to be
// an unexpected error: the consumer did not pause, the probe (select 1) passed anyway, and a message
// spent its 5 receives in ~15 s and went to the DLQ. Now 25006 is DATABASE_UNAVAILABLE (503 on HTTP,
// pause on the queue) and the probe checks that the database writes.
let db: TestDb;
let queues: TestQueues;
let running: RunningApp;

beforeAll(async () => {
  db = await createTestDb("dbreadonly");
  queues = await createTestQueues("dbreadonly", { visibilityTimeoutS: 30, maxReceiveCount: 5 });
  running = await startApp(db, {
    env: { ...queues.env, ENABLE_SQS_CONSUMER: "true", SQS_RETRY_BASE_MS: "1000", SQS_RETRY_MAX_MS: "30000" },
  });
});
afterAll(async () => {
  await db?.owner.unsafe(`alter database "${db.name}" reset default_transaction_read_only`).catch(() => {});
  await running?.close();
  await db?.drop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pausedGauge = async () => {
  const m = (await (await fetch(`${running.baseUrl}/metrics`)).text()).match(/^sqs_consumer_paused (\d+)/m);
  return m ? Number(m[1]) : -1;
};

/** New sessions of the app role start read-only; the open ones are cut so the pool reconnects. */
async function setReadOnly(on: boolean): Promise<void> {
  await db.owner.unsafe(`alter database "${db.name}" ${on ? "set default_transaction_read_only = on" : "reset default_transaction_read_only"}`);
  await db.owner`select pg_terminate_backend(pid) from pg_stat_activity
                 where datname = current_database() and usename = 'wager_app'`;
}

describe("Postgres that reads but refuses writes", () => {
  it("pauses the consumer, answers 503 on HTTP, keeps the message out of the DLQ and applies it when writes return", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);
    const { key, body } = wagerBody({ walletId, playerId, amount: "10.00" });

    await setReadOnly(true);
    try {
      // HTTP: transient, the provider resends the same request (the first call may hit a cut connection)
      let http = await postWager(running.baseUrl, { walletId, playerId, amount: "5.00" });
      if (http.status !== 503) http = await postWager(running.baseUrl, { walletId, playerId, amount: "5.00" });
      expect(http.status).toBe(503);
      expect(http.body.code).toBe("DATABASE_UNAVAILABLE");

      await sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope({ ...body, idempotencyKey: key })), walletId);
      await waitFor(async () => (await pausedGauge()) === 1, 15_000);
      const ready = (await (await fetch(`${running.baseUrl}/health/ready`)).json()) as { checks: Record<string, string> };
      expect(ready.checks.postgres).toBe("fail");
      await sleep(20_000); // longer than the 4 retries (1 + 2 + 4 + 8 s) would have taken
      expect(await pausedGauge()).toBe(1);
    } finally {
      await setReadOnly(false);
    }

    await waitFor(async () => (await call(running.baseUrl, "GET", `/wallets/${walletId}`).catch(() => undefined))?.body?.balance?.amount === "90.00", 20_000);
    expect(await pausedGauge()).toBe(0);
    expect(await receiveAll(queues.urls.dlq, { waitS: 1 })).toHaveLength(0);
  }, 90_000);
});
