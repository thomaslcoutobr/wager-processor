import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createWallet, type RunningApp, startApp } from "../helpers/app";
import { RecordingBus } from "../helpers/recording-bus";
import { createTestQueues, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

// H4: the publisher sends inside the transaction that holds the claimed rows (SKIP LOCKED). A slow or
// hanging SQS used to keep that transaction (and its pool connection) open for the whole batch.
let db: TestDb;
let queues: TestQueues;
let running: RunningApp;
let bus!: RecordingBus;

beforeAll(async () => {
  db = await createTestDb("outboxslow");
  queues = await createTestQueues("outboxslow");
  running = await startApp(db, {
    env: { ...queues.env, OUTBOX_BATCH_SIZE: "50", OUTBOX_PASS_BUDGET_MS: "500" },
    wrapEventBus: (b) => (bus = new RecordingBus(b)),
  });
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

const pending = async () => (await db.app`select count(*)::int as n from outbox_messages where published_at is null`)[0].n as number;

async function drain(): Promise<void> {
  bus.delayMs = 0;
  bus.failWith = undefined;
  await db.owner`update outbox_messages set next_attempt_at = now() where published_at is null`;
  while ((await pending()) > 0) await running.container.outboxPublisher.runOnce();
}

describe("a pass of the outbox publisher is bounded in time", () => {
  it("with a slow SQS, the pass stops at its time budget and the rest goes in the next pass", async () => {
    await drain();
    for (let i = 0; i < 6; i++) await createWallet(running.baseUrl, "10.00"); // 2 events each, 6 groups
    expect(await pending()).toBe(12);
    bus.delayMs = 200;
    const started = performance.now();
    const published = await running.container.outboxPublisher.runOnce();
    const tookMs = performance.now() - started;
    expect(published).toBeGreaterThanOrEqual(1);
    expect(published).toBeLessThanOrEqual(4);
    expect(tookMs).toBeLessThan(1_500);
    expect(await pending()).toBe(12 - published);
    await drain();
    expect(await pending()).toBe(0);
  });

  it("with SQS failing, the pass stops at the first failure instead of trying every group", async () => {
    await drain();
    for (let i = 0; i < 5; i++) await createWallet(running.baseUrl, "10.00");
    bus.failWith = new Error("SQS is down");
    expect(await running.container.outboxPublisher.runOnce()).toBe(0);
    const [tried] = await db.app`select count(*)::int as n from outbox_messages where published_at is null and attempts > 0`;
    expect(tried.n).toBe(1);
    await drain();
  });
});
