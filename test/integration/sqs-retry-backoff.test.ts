import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, type RunningApp, startApp, wagerBody } from "../helpers/app";
import { waitFor } from "../helpers/locks";
import { createTestQueues, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

// Ld-06: every other queue test runs with the retry backoff at 0, so they would still pass if the
// consumer handed the message back with VisibilityTimeout 0. Here the backoff is real.

let db: TestDb;
let queues: TestQueues;
let running: RunningApp;

beforeAll(async () => {
  db = await createTestDb("backoff");
  queues = await createTestQueues("backoff", { visibilityTimeoutS: 2, maxReceiveCount: 5 });
  running = await startApp(db, {
    env: { ...queues.env, ENABLE_SQS_CONSUMER: "true", SQS_RETRY_BASE_MS: "4000", SQS_RETRY_MAX_MS: "4000" },
  });
});
afterAll(async () => {
  running?.failpoints.clear();
  await running?.close();
  await db?.drop();
});

const retries = async () => {
  const text = await (await fetch(`${running.baseUrl}/metrics`)).text();
  const m = /^sqs_retries_total (\S+)$/m.exec(text);
  return m ? Number(m[1]) : 0;
};

describe("consumer retry backoff (Ld-06)", () => {
  it("after a transient failure the message stays invisible for the backoff, then is applied once", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);
    const { key, body } = wagerBody({ walletId, playerId, amount: "10.00" });
    running.failpoints.set("usecase.before_commit", "transient");
    await sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope({ ...body, idempotencyKey: key })), walletId);
    await waitFor(async () => (await retries()) >= 1, 15_000);
    running.failpoints.clear();
    const t0 = Date.now();
    await waitFor(async () => (await call(running.baseUrl, "GET", `/wallets/${walletId}`)).body.balance.amount === "90.00", 20_000);
    const elapsedMs = Date.now() - t0;
    // receive 1, base = ceiling = 4 s: equal jitter gives 2 to 4 s. Handed back at 0 s it returns in ~1 s.
    expect(elapsedMs).toBeGreaterThanOrEqual(1_500);
    expect(elapsedMs).toBeLessThan(8_000);
    expect(await retries()).toBe(1);
  }, 60_000);
});
