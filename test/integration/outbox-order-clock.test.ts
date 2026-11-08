// R2b-02: inside a group (a wallet) the outbox used to order by (occurred_at, id), and occurred_at is
// the clock of the instance that decided. Two instances 5 ms apart published version 3 before 2.
// Now the order is `seq`, drawn under the wallet lock. Two apps on one database, each with its own
// TestClock; the bus only records the order, so this does not depend on the emulator.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { EventBus } from "../../src/application/ports";
import type { OutboxMessage } from "../../src/domain/outbox-message";
import { createWallet, postWager, type RunningApp, startApp, TestClock } from "../helpers/app";
import { createTestDb, type TestDb } from "../helpers/test-db";

class OrderOnlyBus implements EventBus {
  readonly versions: Array<{ group: string; walletVersion: number }> = [];
  async publish(message: OutboxMessage): Promise<void> {
    if (message.eventType === "WalletBalanceChanged") {
      const data = (message.payload as { data: { walletVersion: number } }).data;
      this.versions.push({ group: message.messageGroupId, walletVersion: data.walletVersion });
    }
  }
  async check(): Promise<void> {}
}

let db: TestDb;
const bus = new OrderOnlyBus();
let a: RunningApp;
let bBehind: RunningApp;
let bSame: RunningApp;

beforeAll(async () => {
  db = await createTestDb("outbox_clock");
  const t0 = new Date("2026-11-08T12:00:00.000Z").getTime();
  // A is 5 ms ahead of B; a third app shares A's clock exactly (control)
  const clockA = new TestClock(new Date(t0 + 5));
  const clockB = new TestClock(new Date(t0));
  const wrap = () => bus;
  a = await startApp(db, { clock: clockA, wrapEventBus: wrap });
  bBehind = await startApp(db, { clock: clockB, wrapEventBus: wrap });
  bSame = await startApp(db, { clock: new TestClock(new Date(t0 + 5)), wrapEventBus: wrap });
});
afterAll(async () => {
  await a?.close();
  await bBehind?.close();
  await bSame?.close();
  await db?.drop();
});

async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((await a.container.outboxPublisher.runOnce()) === 0) return;
  }
}

/** Opening on A, BET 1 on A, BET 2 on `second`; returns the walletVersion order the publisher emitted. */
async function orderFor(second: RunningApp): Promise<number[]> {
  const playerId = crypto.randomUUID();
  const walletId = await createWallet(a.baseUrl, "100.00", playerId);
  expect((await postWager(a.baseUrl, { walletId, playerId, amount: "1.00" })).status).toBe(200); // walletVersion 2
  expect((await postWager(second.baseUrl, { walletId, playerId, amount: "2.00" })).status).toBe(200); // walletVersion 3, decided later
  await drain();
  return bus.versions.filter((v) => v.group === walletId).map((v) => v.walletVersion);
}

describe("per-wallet event order across instances with different clocks", () => {
  it("an instance 5 ms behind decides the next BET: the events still leave as versions 1, 2, 3", async () => {
    expect(await orderFor(bBehind)).toEqual([1, 2, 3]);
  }, 30_000);

  it("control: the same clock on both instances gives 1, 2, 3", async () => {
    expect(await orderFor(bSame)).toEqual([1, 2, 3]);
  }, 30_000);
});
