import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createWallet, postWager, type RunningApp, startApp } from "../helpers/app";
import { ReferenceEventConsumer } from "../helpers/event-consumer";
import { RecordingBus } from "../helpers/recording-bus";
import { createTestQueues, receiveAll, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

let db: TestDb;
let queues: TestQueues;
let apps: RunningApp[] = [];

beforeAll(async () => {
  db = await createTestDb("outbox");
  queues = await createTestQueues("outbox");
  // three instances over the same outbox; the background publisher stays off, tests drive it
  for (let i = 0; i < 3; i++) {
    apps.push(await startApp(db, { env: { ...queues.env, OUTBOX_BATCH_SIZE: "10" }, wrapEventBus: (b) => new RecordingBus(b) }));
  }
});
afterAll(async () => {
  for (const a of apps) await a.close();
  await db?.drop();
});

const pending = async () => (await db.app`select count(*)::int as n from outbox_messages where published_at is null`)[0].n as number;

describe("outbox publisher", () => {
  it("publishes committed events to wager-events.fifo grouped by wallet, deduplicated by eventId", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(apps[0]!.baseUrl, "10.00", playerId);
    await apps[0]!.container.outboxPublisher.runOnce();
    const msgs = await receiveAll(queues.urls.events, { waitS: 1 });
    const mine = msgs.filter((m) => m.Attributes?.MessageGroupId === walletId);
    expect(mine.length).toBe(2);
    for (const m of mine) {
      const env = JSON.parse(m.Body!);
      expect(m.Attributes?.MessageDeduplicationId).toBe(env.eventId);
      expect(["WagerTransactionProcessed", "WalletBalanceChanged"]).toContain(env.eventType);
      expect(env.data.money?.amount ?? env.data.balanceAfter?.amount).toBe("10.00");
    }
    const [row] = await db.app`select count(*)::int as n from outbox_messages where message_group_id = ${walletId} and published_at is not null`;
    expect(row.n).toBe(2);
  });

  it("3 concurrent publishers over 300 events: every row published exactly once, none left behind", async () => {
    // drain what earlier tests left
    while ((await pending()) > 0) await apps[0]!.container.outboxPublisher.runOnce();
    const players = Array.from({ length: 30 }, () => crypto.randomUUID());
    const wallets = await Promise.all(players.map((p) => createWallet(apps[0]!.baseUrl, "1000.00", p)));
    await Promise.all(
      wallets.flatMap((walletId, i) => Array.from({ length: 4 }, () => postWager(apps[0]!.baseUrl, { walletId, playerId: players[i]!, amount: "1.00" }))),
    );
    const total = await pending();
    expect(total).toBe(30 * 2 + 30 * 4 * 2); // opening (2 events) + 4 bets (2 events each)

    const sentBy = new Map<string, string[]>();
    for (const [i, a] of apps.entries()) {
      (a.container.eventBus as RecordingBus).onPublished = (id: string) => sentBy.set(id, [...(sentBy.get(id) ?? []), `pub-${i}`]);
    }
    const loop = async (a: RunningApp) => {
      for (let idle = 0; idle < 3; ) idle = (await a.container.outboxPublisher.runOnce()) === 0 ? idle + 1 : 0;
    };
    await Promise.all(apps.map(loop));
    expect(await pending()).toBe(0);
    expect(sentBy.size).toBe(total);
    expect([...sentBy.values()].filter((v) => v.length > 1).length).toBe(0);
    const used = new Set([...sentBy.values()].flat());
    expect(used.size).toBeGreaterThan(1); // the work really was shared
  });

  it("keeps the rows and backs off when SQS fails, and the lag is visible", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(apps[0]!.baseUrl, "5.00", playerId);
    const bus = apps[1]!.container.eventBus as RecordingBus;
    bus.failWith = new Error("sqs down");
    try {
      await apps[1]!.container.outboxPublisher.runOnce();
    } finally {
      bus.failWith = undefined;
    }
    const rows = await db.app`select attempts, last_error, next_attempt_at > now() as later, published_at
                               from outbox_messages where message_group_id = ${walletId} order by occurred_at, id`;
    // the first failure skips the rest of the same group in that batch (keeps per-wallet order)
    expect(rows[0]).toMatchObject({ attempts: 1, last_error: "Error: sqs down", later: true, published_at: null });
    expect(rows[1]).toMatchObject({ attempts: 0, published_at: null });
    const metrics = await (await fetch(`${apps[1]!.baseUrl}/metrics`)).text();
    expect(metrics).toMatch(/outbox_pending [1-9]/);
    expect(metrics).toMatch(/outbox_lag_seconds \d/);
  });

  it("a duplicate publication is harmless for a consumer that dedupes by eventId", async () => {
    const consumer = new ReferenceEventConsumer(db.owner, queues.urls.events);
    await consumer.setup();
    await consumer.drain();
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(apps[0]!.baseUrl, "7.00", playerId);
    await apps[0]!.container.outboxPublisher.runOnce();
    const [raw] = await db.app`select payload from outbox_messages where message_group_id = ${walletId} limit 1`;
    const row = { payload: typeof raw.payload === "string" ? JSON.parse(raw.payload) : raw.payload };
    // a real duplicate: same envelope, another MessageDeduplicationId so FIFO cannot collapse it
    await sendRaw(queues.urls.events, JSON.stringify(row.payload), walletId, `dup-${crypto.randomUUID()}`);
    const handled = await consumer.drain();
    expect(handled).toBeGreaterThanOrEqual(3); // 2 events + the duplicate
    const effects = await consumer.effectsPerEvent();
    expect(effects.get(row.payload.eventId)).toBe(1);
    expect([...effects.values()].every((n) => n === 1)).toBe(true);
  });
});
