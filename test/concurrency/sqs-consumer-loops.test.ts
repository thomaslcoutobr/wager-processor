import { afterEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { call, createWallet, postWager, type RunningApp, startApp, wagerBody } from "../helpers/app";
import { backendsWaitingOnLock, holdWalletLock, waitFor } from "../helpers/locks";
import { spawnApp } from "../helpers/spawn";
import { createTestQueues, queueDepth, receiveAll, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

// ARCHITECTURE §12: N receive loops, ONE message per ReceiveMessage. SQS counts receives, not
// attempts, so a message must only be received when it is about to be tried. These tests pin the
// failures of the old batch-of-10 consumer (review findings R1-01, Lb-01, Lb-03, Lb-04) and the
// guarantees the loops must keep (order inside a wallet, room left in the pool).
// Each test tears down what it opened right away: apps and pools left open until the end of the file
// add up to Postgres' max_connections, and the last test would see DATABASE_UNAVAILABLE.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {});
});

async function freshDb(label: string): Promise<TestDb> {
  const db = await createTestDb(label);
  cleanup.push(() => db.drop());
  return db;
}

/** App with the consumer constructed but not started, so the messages are queued before the first receive. */
async function appWithIdleConsumer(db: TestDb, queues: TestQueues, env: Record<string, string> = {}): Promise<RunningApp> {
  const running = await startApp(db, { env: { ...queues.env, ENABLE_SQS_CONSUMER: "false", ...env } });
  cleanup.push(async () => {
    await running.container.consumer.stop();
    await running.close();
  });
  return running;
}

function queuedWager(walletId: string, playerId: string, amount: string) {
  const { key, body } = wagerBody({ walletId, playerId, amount });
  return requestedEnvelope({ ...body, idempotencyKey: key });
}

const balanceOf = async (baseUrl: string, walletId: string) =>
  (await call(baseUrl, "GET", `/wallets/${walletId}`)).body.balance.amount as string;

/** A separate pool for the test's own row locks, so holding many of them never starves the test's queries. */
function lockPool(db: TestDb): SQL {
  const sql = new SQL({ url: db.ownerUrl, max: 16 });
  cleanup.push(() => sql.close());
  return sql;
}

describe("SQS consumer: one message per receive", () => {
  it("R1-01: a head that fails transiently up to the DLQ does not drag the followers of its group there", async () => {
    const db = await freshDb("loops_r101");
    const queues = await createTestQueues("r101", { visibilityTimeoutS: 2, maxReceiveCount: 5 });
    const running = await appWithIdleConsumer(db, queues, { LOCK_TIMEOUT_MS: "200" });
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);
    const lockedPlayer = crypto.randomUUID();
    const lockedWallet = await createWallet(running.baseUrl, "100.00", lockedPlayer);

    // The head is in the wallet's group but targets a wallet the test keeps locked, so only the head
    // fails (LOCK_TIMEOUT, transient) and the followers are free to succeed whenever they are tried.
    const lock = await holdWalletLock(lockPool(db), lockedWallet);
    cleanup.push(() => lock.release());
    const head = queuedWager(lockedWallet, lockedPlayer, "10.00");
    const followers = [queuedWager(walletId, playerId, "20.00"), queuedWager(walletId, playerId, "30.00")];
    for (const e of [head, ...followers]) await sendRaw(queues.urls.main, JSON.stringify(e), walletId);

    running.container.consumer.start();
    await waitFor(async () => (await balanceOf(running.baseUrl, walletId)) === "50.00", 40_000).catch(() => {});
    const dead = await receiveAll(queues.urls.dlq, { waitS: 1 });

    expect(dead.map((m) => JSON.parse(m.Body!).messageId)).toEqual([head.messageId]);
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toBe("RETRY_LIMIT_EXCEEDED");
    expect(await balanceOf(running.baseUrl, walletId)).toBe("50.00");
  }, 90_000);

  it("Lb-01: five poison messages at the head of a group do not send the valid one behind them to the DLQ", async () => {
    const db = await freshDb("loops_lb01");
    const queues = await createTestQueues("lb01", { visibilityTimeoutS: 30, maxReceiveCount: 5 });
    const running = await appWithIdleConsumer(db, queues);
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "100.00", playerId);

    const poison = Array.from({ length: 5 }, () => queuedWager(walletId, playerId, "1e3")); // INVALID_AMOUNT
    const valid = queuedWager(walletId, playerId, "10.00");
    for (const e of [...poison, valid]) await sendRaw(queues.urls.main, JSON.stringify(e), walletId);

    running.container.consumer.start();
    await waitFor(async () => (await balanceOf(running.baseUrl, walletId)) === "90.00", 20_000).catch(() => {});
    const dead = [...(await receiveAll(queues.urls.dlq, { waitS: 1 })), ...(await receiveAll(queues.urls.dlq, { waitS: 1 }))];

    expect(await balanceOf(running.baseUrl, walletId)).toBe("90.00");
    expect(dead.map((m) => JSON.parse(m.Body!).messageId).sort()).toEqual(poison.map((p) => p.messageId).sort());
    // every dead letter was tried by the app and carries its reason (none was moved by the redrive policy)
    expect(dead.every((m) => m.MessageAttributes?.failureReason?.StringValue === "INVALID_AMOUNT")).toBe(true);
  }, 60_000);

  it("Lb-03: a wallet stuck on its row lock does not stop the consumer from applying another wallet", async () => {
    const db = await freshDb("loops_lb03");
    const queues = await createTestQueues("lb03", { visibilityTimeoutS: 60 });
    const running = await startApp(db, { env: { ...queues.env, ENABLE_SQS_CONSUMER: "true", LOCK_TIMEOUT_MS: "15000" } });
    cleanup.push(() => running.close());
    const p1 = crypto.randomUUID();
    const w1 = await createWallet(running.baseUrl, "100.00", p1);
    const p3 = crypto.randomUUID();
    const w3 = await createWallet(running.baseUrl, "100.00", p3);

    const lock = await holdWalletLock(lockPool(db), w1);
    cleanup.push(() => lock.release());
    await sendRaw(queues.urls.main, JSON.stringify(queuedWager(w1, p1, "10.00")), w1);
    await waitFor(async () => (await backendsWaitingOnLock(db.app)) >= 1, 10_000);

    await sendRaw(queues.urls.main, JSON.stringify(queuedWager(w3, p3, "10.00")), w3);
    const started = Date.now();
    await waitFor(async () => (await balanceOf(running.baseUrl, w3)) === "90.00", 3_000);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await balanceOf(running.baseUrl, w1)).toBe("100.00"); // still held by the test's lock

    await lock.release();
    await waitFor(async () => (await balanceOf(running.baseUrl, w1)) === "90.00", 10_000);
  }, 60_000);

  it("keeps the order of a wallet: 20 queued bets are applied in the order they were sent, with 4 loops", async () => {
    const db = await freshDb("loops_order");
    const queues = await createTestQueues("order", { visibilityTimeoutS: 30 });
    const running = await appWithIdleConsumer(db, queues, { SQS_CONSUMER_CONCURRENCY: "4" });
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(running.baseUrl, "1000.00", playerId);
    const amounts = Array.from({ length: 20 }, (_, i) => `${i + 1}.00`);
    for (const a of amounts) await sendRaw(queues.urls.main, JSON.stringify(queuedWager(walletId, playerId, a)), walletId);

    running.container.consumer.start();
    await waitFor(async () => (await balanceOf(running.baseUrl, walletId)) === "790.00", 30_000);
    const rows = await db.app`select amount::text as a from wallet_ledger_entries
                              where wallet_id = ${walletId} and direction = 'DEBIT' order by wallet_version`;
    expect(rows.map((r: { a: string }) => r.a)).toEqual(amounts);
  }, 60_000);

  it("leaves room in the pool: 10 queued wallets stuck on locks do not block an HTTP request for another wallet", async () => {
    const db = await freshDb("loops_pool");
    const queues = await createTestQueues("pool", { visibilityTimeoutS: 60 });
    const running = await appWithIdleConsumer(db, queues, { DB_POOL_MAX: "10", SQS_CONSUMER_CONCURRENCY: "4", LOCK_TIMEOUT_MS: "15000" });
    const locks = lockPool(db);
    const stuck: Array<{ walletId: string; release(): Promise<void> }> = [];
    for (let i = 0; i < 10; i++) {
      const playerId = crypto.randomUUID();
      const walletId = await createWallet(running.baseUrl, "100.00", playerId);
      const lock = await holdWalletLock(locks, walletId);
      cleanup.push(() => lock.release());
      stuck.push({ walletId, release: () => lock.release() });
      await sendRaw(queues.urls.main, JSON.stringify(queuedWager(walletId, playerId, "10.00")), walletId);
    }
    const freePlayer = crypto.randomUUID();
    const freeWallet = await createWallet(running.baseUrl, "100.00", freePlayer);

    running.container.consumer.start();
    // the 4 loops are all waiting on a lock (the old batch consumer had all 10 waiting, the whole pool)
    await waitFor(async () => (await backendsWaitingOnLock(db.app)) >= 4, 10_000);
    const started = Date.now();
    const r = await postWager(running.baseUrl, { walletId: freeWallet, playerId: freePlayer, amount: "10.00" });
    expect(r.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_000);

    for (const s of stuck) await s.release();
    await waitFor(async () => {
      const [n] = await db.app`select count(*)::int as n from wallets where balance = 90.00`;
      return n.n === 11;
    }, 20_000);
  }, 90_000);

  it("Lb-04: SIGTERM past the grace hands every message of the group back, and another instance takes the head at once", async () => {
    const db = await freshDb("loops_lb04");
    const queues = await createTestQueues("lb04", { visibilityTimeoutS: 30 });
    const setup = await startApp(db, { env: { ...queues.env } });
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(setup.baseUrl, "100.00", playerId);
    await setup.close();
    const envs = ["10.00", "20.00", "30.00"].map((a) => queuedWager(walletId, playerId, a));
    for (const e of envs) await sendRaw(queues.urls.main, JSON.stringify(e), walletId);

    const env = { ...queues.env, DATABASE_URL: db.appUrl, ENABLE_SQS_CONSUMER: "true", ENABLE_OUTBOX_PUBLISHER: "false", ENABLE_PENDING_WORKER: "false" };
    const slow = await spawnApp({ ...env, FAILPOINTS: "usecase.before_commit=delay:6000", SHUTDOWN_GRACE_MS: "300" });
    await slow.waitForLine(/"msg":"processing message"/);
    slow.kill("SIGTERM");
    await slow.exited;
    const [n] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
    expect(n.n).toBe(0); // the slow one never committed: its transaction died with the process
    expect(await queueDepth(queues.urls.main)).toEqual({ visible: 3, inFlight: 0 });

    const next = await spawnApp(env);
    try {
      const started = Date.now();
      await waitFor(async () => {
        const [w] = await db.app`select balance::text as b from wallets where id = ${walletId}`;
        return w.b === "40.00";
      }, 10_000);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      next.kill("SIGTERM");
      expect(await next.exited).toBe(0);
    }
  }, 60_000);
});
