import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, gate, wagerBody } from "../helpers/app";
import { expectGlobalConsistency } from "../helpers/invariants";
import { waitFor } from "../helpers/locks";
import { spawnApp, type SpawnedApp } from "../helpers/spawn";
import { createTestQueues, queueDepth, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

let db: TestDb;
let queues: TestQueues;
let instances: SpawnedApp[] = [];

beforeAll(async () => {
  db = await createTestDb("multi");
  queues = await createTestQueues("multi");
  const env = {
    ...queues.env,
    DATABASE_URL: db.appUrl,
    ENABLE_SQS_CONSUMER: "true",
    ENABLE_OUTBOX_PUBLISHER: "true",
    ENABLE_PENDING_WORKER: "true",
    OUTBOX_POLL_MS: "100",
    PENDING_POLL_MS: "100",
  };
  instances = await Promise.all([spawnApp(env), spawnApp(env), spawnApp(env)]);
});
afterAll(async () => {
  for (const i of instances) i.kill("SIGTERM");
  await Promise.all(instances.map((i) => i.exited));
  await db?.drop();
});

const url = (i: number) => instances[i % instances.length]!.baseUrl;

describe("three application processes at the same time (section 13, test 4)", () => {
  it("100.00 vs two bets of 80.00 on two different instances: one debit (20 rounds)", async () => {
    for (let round = 0; round < 20; round++) {
      const playerId = crypto.randomUUID();
      const w = await call(url(round), "POST", "/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } });
      const walletId = w.body.id as string;
      const g = gate();
      const both = [0, 1].map(async (k) => {
        const { key, body } = wagerBody({ walletId, playerId, amount: "80.00" });
        await g.wait;
        return call(url(round + k + 1), "POST", "/wagering/transactions", body, { "Idempotency-Key": key });
      });
      g.open();
      const res = await Promise.all(both);
      expect(res.map((r) => r.status).sort()).toEqual([200, 422]);
      expect((await call(url(round + 2), "GET", `/wallets/${walletId}`)).body.balance.amount).toBe("20.00");
    }
  });

  it("a distributed burst over HTTP and SQS on shared wallets keeps every invariant", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const playerId = crypto.randomUUID();
        const r = await call(url(i), "POST", "/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } });
        return { walletId: r.body.id as string, playerId };
      }),
    );
    const g = gate();
    const ops: Promise<unknown>[] = [];
    for (const [wi, w] of wallets.entries()) {
      // the SAME bet sent to the three instances at once
      const same = wagerBody({ ...w, amount: "7.00" });
      for (let i = 0; i < 3; i++) {
        ops.push(g.wait.then(() => call(url(i), "POST", "/wagering/transactions", same.body, { "Idempotency-Key": same.key })));
      }
      // competing bets and wins, round-robin over the instances (some bets will run out of funds)
      for (let k = 0; k < 15; k++) {
        const kind = k % 3 === 0 ? "WIN" : "BET";
        const req = wagerBody({ ...w, kind, amount: kind === "WIN" ? "5.00" : "10.00" });
        ops.push(g.wait.then(() => call(url(wi + k), "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key })));
      }
      // a refund that arrives (on one instance) before its bet (on another)
      const betId = `bet-${crypto.randomUUID()}`;
      const refund = wagerBody({ ...w, kind: "REFUND", amount: "3.00", referenceExternalTransactionId: betId });
      const bet = wagerBody({ ...w, externalTransactionId: betId, amount: "3.00" });
      ops.push(
        g.wait.then(async () => {
          await call(url(wi), "POST", "/wagering/transactions", refund.body, { "Idempotency-Key": refund.key });
          await call(url(wi + 1), "POST", "/wagering/transactions", bet.body, { "Idempotency-Key": bet.key });
        }),
      );
      // queue traffic, consumed by whichever instance gets it
      for (let k = 0; k < 4; k++) {
        const q = wagerBody({ ...w, kind: "LOSS", amount: "1.00" });
        ops.push(g.wait.then(() => sendRaw(queues.urls.main, JSON.stringify(requestedEnvelope({ ...q.body, idempotencyKey: q.key })), w.walletId)));
      }
    }
    g.open();
    await Promise.all(ops);

    // eventual state: queue drained, no reversal left waiting, every event published
    await waitFor(async () => {
      const d = await queueDepth(queues.urls.main);
      return d.visible === 0 && d.inFlight === 0;
    }, 30_000);
    await waitFor(async () => (await db.app`select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'`)[0].n === 0, 30_000);
    await waitFor(async () => (await db.app`select count(*)::int as n from outbox_messages where published_at is null`)[0].n === 0, 30_000);

    const ids = wallets.map((w) => w.walletId);
    await expectGlobalConsistency(db.app, ids);
    for (const [i, id] of ids.entries()) {
      const r = await call(url(i), "POST", `/wallets/${id}/reconciliation`);
      expect(r.body.consistent).toBe(true);
    }
    const [same] = await db.app`select count(*)::int as n from wager_transactions where wallet_id in ${db.app(ids)} and amount = 7.00`;
    expect(same.n).toBe(wallets.length); // the triple-sent bet exists once per wallet
    const [losses] = await db.app`select count(*)::int as n from wager_transactions where wallet_id in ${db.app(ids)} and kind = 'LOSS'`;
    expect(losses.n).toBe(wallets.length * 4);
    // the queue work really was spread over more than one process
    const consumers = instances.filter((i) => i.lines.some((l) => l.includes('"msg":"processing message"'))).length;
    expect(consumers).toBeGreaterThan(1);
  });
});
