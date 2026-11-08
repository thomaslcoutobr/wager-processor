import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { EventBus } from "../../src/application/ports";
import type { OutboxMessage } from "../../src/domain/outbox-message";
import { createWallet, gate, postWager, type RunningApp, startApp, TestClock } from "../helpers/app";
import { waitFor } from "../helpers/locks";
import { createTestQueues, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

// Lb-08: per-wallet order of the published events. The publisher used to skip the rest of a group
// only inside one batch: after the head failed, the next pass published the later events before it,
// and a second publisher could take a later event while the first still held the head.
// Now a publisher claims the HEAD of each group (its oldest unpublished event) and then that group's
// events in order; a later event is never a head while the head is unpublished.

/** Real bus plus: the order of publication, failures for chosen events, and a gate to hold one in flight. */
class OrderBus implements EventBus {
  readonly published: string[] = [];
  failFor = new Set<string>();
  holdFor?: { id: string; reached: () => void; release: Promise<void> };

  constructor(private readonly inner: EventBus) {}

  async publish(message: OutboxMessage): Promise<void> {
    if (this.failFor.has(message.id)) throw new Error("sqs down for this event");
    if (this.holdFor?.id === message.id) {
      this.holdFor.reached();
      await this.holdFor.release;
    }
    await this.inner.publish(message);
    this.published.push(message.id);
  }

  check(): Promise<void> {
    return this.inner.check();
  }
}

let db: TestDb;
let queues: TestQueues;
let clock: TestClock;
const buses: OrderBus[] = [];
let a: RunningApp;
let b: RunningApp;

beforeAll(async () => {
  db = await createTestDb("outboxorder");
  queues = await createTestQueues("outboxorder");
  clock = new TestClock(new Date("2026-11-08T12:00:00.000Z"));
  const wrap = (inner: EventBus) => {
    const bus = new OrderBus(inner);
    buses.push(bus);
    return bus;
  };
  // A takes one event per pass, B up to 10: B would grab the later events if anything let it
  a = await startApp(db, { clock, env: { ...queues.env, OUTBOX_BATCH_SIZE: "1" }, wrapEventBus: wrap });
  b = await startApp(db, { clock, env: { ...queues.env, OUTBOX_BATCH_SIZE: "10" }, wrapEventBus: wrap });
});
afterAll(async () => {
  await a?.close();
  await b?.close();
  await db?.drop();
});

async function walletWithEvents(): Promise<{ walletId: string; events: string[] }> {
  const playerId = crypto.randomUUID();
  const walletId = await createWallet(a.baseUrl, "100.00", playerId);
  for (const amount of ["1.00", "2.00"]) expect((await postWager(a.baseUrl, { walletId, playerId, amount })).status).toBe(200);
  const rows = await db.app`select id from outbox_messages where message_group_id = ${walletId} order by occurred_at, id`;
  return { walletId, events: rows.map((r: { id: string }) => r.id) };
}

const publishedOf = (events: string[]) => buses.flatMap((x) => x.published).filter((id) => events.includes(id));
const drain = async () => {
  for (let i = 0; i < 20; i++) {
    await b.container.outboxPublisher.runOnce();
    const [n] = await db.app`select count(*)::int as n from outbox_messages where published_at is null`;
    if (n.n === 0) return;
  }
};

describe("outbox per-wallet order", () => {
  it("after the head of a wallet fails, no later event of that wallet is published before it", async () => {
    const { events } = await walletWithEvents();
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const bus of buses) bus.failFor.add(events[0]!);

    await b.container.outboxPublisher.runOnce(); // the head fails and is scheduled for later
    await b.container.outboxPublisher.runOnce(); // later events are due, the head is not
    await a.container.outboxPublisher.runOnce();
    expect(publishedOf(events)).toEqual([]);

    for (const bus of buses) bus.failFor.clear();
    clock.advance(120_000); // past the head's retry delay
    await drain();
    expect(publishedOf(events)).toEqual(events);
  }, 60_000);

  it("while one publisher holds the head of a wallet, another one publishes none of its later events", async () => {
    const { events } = await walletWithEvents();
    const reached = gate();
    const release = gate();
    for (const bus of buses) bus.holdFor = { id: events[0]!, reached: reached.open, release: release.wait };

    const first = a.container.outboxPublisher.runOnce(); // claims the head and stops inside publish
    let laterWhileHeld: string[] = [];
    try {
      await reached.wait;
      await b.container.outboxPublisher.runOnce();
      laterWhileHeld = publishedOf(events);
    } finally {
      release.open(); // never leave the first publisher stuck, even when the assertion fails
      await first;
      for (const bus of buses) bus.holdFor = undefined;
    }
    expect(laterWhileHeld).toEqual([]);
    await drain();
    await waitFor(() => publishedOf(events).length === events.length, 5_000);
    expect(publishedOf(events)).toEqual(events);
  }, 60_000);
});
