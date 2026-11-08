// R3-01: the migration that adds seq numbers the rows already in the outbox by the old rule,
// (occurred_at, id). A disposable database is migrated up to 000200, gets the backlog the publisher
// leaves after an SQS failure (the head retried, so physically after its follower), then 000300.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDb, migrateUp, type TestDb } from "../helpers/test-db";

let db: TestDb;
const T0 = new Date("2026-11-08T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeAll(async () => {
  db = await createTestDb("r3_seq_backfill", { migrate: false });
  await migrateUp(db.ownerUrl, { to: "Migration20261108000200_trigger_integrity" });
});
afterAll(async () => {
  await db?.drop();
});

async function insertOutbox(id: string, group: string, occurredAt: Date) {
  await db.owner`insert into outbox_messages (id, aggregate_id, message_group_id, event_type, event_version, payload,
                   occurred_at, attempts, next_attempt_at)
                 values (${id}, ${group}, ${group}, 'WalletBalanceChanged', 1, ${JSON.stringify({ v: id })}::jsonb,
                   ${occurredAt}, 0, ${occurredAt})`;
}

describe("R3-01 Migration20261108000300_outbox_sequence: backfill of seq on an existing backlog", () => {
  const group = crypto.randomUUID(); // a wallet with two unpublished events (SQS was down)
  const head = crypto.randomUUID(); // older event: the publisher tried it and failed
  const follower = crypto.randomUUID(); // newer event: never tried (the group stops at the head)
  const control = crypto.randomUUID(); // another wallet, two events never touched
  const controlHead = crypto.randomUUID();
  const controlFollower = crypto.randomUUID();

  beforeAll(async () => {
    await insertOutbox(head, group, at(0));
    await insertOutbox(follower, group, at(1_000));
    await insertOutbox(controlHead, control, at(2_000));
    await insertOutbox(controlFollower, control, at(3_000));
    // what OutboxMessage.scheduleRetry + markFailedAttempt leave on the head after "sqs down":
    // a new tuple version, physically after the follower
    await db.owner`update outbox_messages set attempts = 1, last_error = 'Error: sqs down', next_attempt_at = ${at(500)}
                   where id = ${head}`;
    const applied = await migrateUp(db.ownerUrl);
    expect(applied).toEqual(["Migration20261108000300_outbox_sequence"]);
  });

  it("inside the group, seq keeps the old order (head before follower)", async () => {
    const rows = await db.owner`select id from outbox_messages where message_group_id = ${group} order by seq`;
    expect(rows.map((r: { id: string }) => r.id)).toEqual([head, follower]);
  });

  it("the head the publisher claims next (step 1 of claimDueOutbox) is still the older event", async () => {
    const rows = await db.owner`
      select o.id from outbox_messages o
       where o.published_at is null and o.next_attempt_at <= ${at(60_000)} and o.message_group_id = ${group}
         and not exists (select 1 from outbox_messages p
                          where p.message_group_id = o.message_group_id and p.published_at is null and p.seq < o.seq)`;
    expect(rows.map((r: { id: string }) => r.id)).toEqual([head]);
  });

  it("control: a group never updated keeps its order", async () => {
    const rows = await db.owner`select id from outbox_messages where message_group_id = ${control} order by seq`;
    expect(rows.map((r: { id: string }) => r.id)).toEqual([controlHead, controlFollower]);
  });
});
