import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call } from "../helpers/app";
import { ReferenceEventConsumer } from "../helpers/event-consumer";
import { waitFor } from "../helpers/locks";
import { spawnApp } from "../helpers/spawn";
import { createTestQueues, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

let db: TestDb;
let queues: TestQueues;

beforeAll(async () => {
  db = await createTestDb("pubs");
  queues = await createTestQueues("pubs");
});
afterAll(async () => {
  await db?.drop();
});

const pending = async () => (await db.app`select count(*)::int as n from outbox_messages where published_at is null`)[0].n as number;

describe("two publishers over the same outbox, one dies mid-batch (section 11 + section 13, test 6)", () => {
  it("commit → crash before publishing → another instance publishes → the consumer applies each event once", async () => {
    const env = { ...queues.env, DATABASE_URL: db.appUrl, ENABLE_SQS_CONSUMER: "false", ENABLE_PENDING_WORKER: "false" };
    // 1. commits happen with no publisher running
    const writer = await spawnApp({ ...env, ENABLE_OUTBOX_PUBLISHER: "false" });
    const wallets: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await call(writer.baseUrl, "POST", "/wallets", { playerId: crypto.randomUUID(), initialBalance: { amount: "10.00", currency: "BRL" } });
      wallets.push(r.body.id);
    }
    writer.kill("SIGTERM");
    await writer.exited;
    const total = await pending();
    expect(total).toBe(40);

    // 2. publisher A sends one event and is killed before its COMMIT (the row stays unpublished)
    const a = await spawnApp({ ...env, ENABLE_OUTBOX_PUBLISHER: "true", OUTBOX_POLL_MS: "50", FAILPOINTS: "outbox.after_send_before_commit=crash" });
    expect(await a.exited).toBe(137);
    expect(await pending()).toBe(total);

    // 3. publishers B and C take over and publish everything (SKIP LOCKED: disjoint batches)
    const b = await spawnApp({ ...env, ENABLE_OUTBOX_PUBLISHER: "true", OUTBOX_POLL_MS: "50" });
    const c = await spawnApp({ ...env, ENABLE_OUTBOX_PUBLISHER: "true", OUTBOX_POLL_MS: "50" });
    try {
      await waitFor(async () => (await pending()) === 0, 20_000);
    } finally {
      b.kill("SIGTERM");
      c.kill("SIGTERM");
      expect(await b.exited).toBe(0);
      expect(await c.exited).toBe(0);
    }

    // 4. the event A had sent was published again (at least once, on purpose); the consumer is safe
    const consumer = new ReferenceEventConsumer(db.owner, queues.urls.events);
    await consumer.setup();
    await consumer.drain();
    const effects = await consumer.effectsPerEvent();
    expect(effects.size).toBe(total);
    expect([...effects.values()].every((n) => n === 1)).toBe(true);
  });
});
