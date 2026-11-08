import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, postWager, startApp, wagerBody } from "../helpers/app";
import { backendsWaitingOnLock, holdWalletLock, waitFor } from "../helpers/locks";
import { spawnApp } from "../helpers/spawn";
import { createTestQueues, queueDepth, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

let db: TestDb;
let queues: TestQueues;

beforeAll(async () => {
  db = await createTestDb("shutdown");
  queues = await createTestQueues("shutdown", { visibilityTimeoutS: 30 });
});
afterAll(async () => {
  await db?.drop();
});

const env = () => ({
  ...queues.env,
  DATABASE_URL: db.appUrl,
  ENABLE_SQS_CONSUMER: "true",
  ENABLE_OUTBOX_PUBLISHER: "false",
  ENABLE_PENDING_WORKER: "false",
});

async function queuedBet(baseUrl: string, amount: string) {
  const playerId = crypto.randomUUID();
  const r = await call(baseUrl, "POST", "/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } });
  const walletId = r.body.id as string;
  const { key, body } = wagerBody({ walletId, playerId, amount });
  const envelope = requestedEnvelope({ ...body, idempotencyKey: key });
  await sendRaw(queues.urls.main, JSON.stringify(envelope), walletId);
  return { walletId, key, envelope };
}

describe("SIGTERM", () => {
  it("drains: readiness goes 503, the message in flight commits and is acked, exit code 0", async () => {
    const app = await spawnApp({ ...env(), FAILPOINTS: "usecase.before_commit=delay:1500", SHUTDOWN_GRACE_MS: "8000" });
    const { walletId, key } = await queuedBet(app.baseUrl, "30.00");
    await app.waitForLine(/"msg":"processing message"/);
    app.kill("SIGTERM");
    await waitFor(async () => (await fetch(`${app.baseUrl}/health/ready`).then((r) => r.status).catch(() => 0)) === 503, 2_000);
    expect(await app.exited).toBe(0);
    const [tx] = await db.app`select status from wager_transactions where idempotency_key = ${key}`;
    expect(tx.status).toBe("PROCESSED");
    const d = await queueDepth(queues.urls.main);
    expect(d.visible + d.inFlight).toBe(0);
    const [w] = await db.app`select balance::text as b from wallets where id = ${walletId}`;
    expect(w.b).toBe("70.00");
  });

  it("when the grace period runs out, the message is handed back at once (visibility 0) for another instance", async () => {
    const slow = await spawnApp({ ...env(), FAILPOINTS: "usecase.before_commit=delay:6000", SHUTDOWN_GRACE_MS: "300" });
    const { walletId, key } = await queuedBet(slow.baseUrl, "10.00");
    await slow.waitForLine(/"msg":"processing message"/);
    slow.kill("SIGTERM");
    await slow.exited; // forced out after the grace; its open transaction dies with the connection
    const [n] = await db.app`select count(*)::int as n from wager_transactions where idempotency_key = ${key}`;
    expect(n.n).toBe(0);
    // visibility was 30 s: only an explicit hand-back makes it available right away
    const d = await queueDepth(queues.urls.main);
    expect(d.visible).toBe(1);

    const next = await spawnApp(env());
    try {
      await waitFor(async () => {
        const [w] = await db.app`select balance::text as b from wallets where id = ${walletId}`;
        return w.b === "90.00";
      }, 10_000);
    } finally {
      next.kill("SIGTERM");
      expect(await next.exited).toBe(0);
    }
  });

  // Lb-07: the pollers check the stop between units of work, so the drain waits for one batch or one
  // candidate, never for the whole backlog (which ended at the hard stop with exit code 1).
  it("with an outbox backlog, the publisher stops after the batch in flight and the exit code is 0", async () => {
    const writer = await startApp(db, { env: { ...queues.env } }); // publisher off: the outbox piles up
    try {
      for (let i = 0; i < 30; i++) {
        await Promise.all(Array.from({ length: 10 }, () => createWallet(writer.baseUrl, "100.00")));
      }
    } finally {
      await writer.close();
    }
    const backlog = async () => (await db.app`select count(*)::int as n from outbox_messages where published_at is null`)[0].n as number;
    expect(await backlog()).toBeGreaterThanOrEqual(300);

    // 200 ms per event, so each batch of 10 takes ~2 s and the whole backlog far more than the grace
    const app = await spawnApp({
      ...env(),
      ENABLE_SQS_CONSUMER: "false",
      ENABLE_OUTBOX_PUBLISHER: "true",
      FAILPOINTS: "outbox.after_send_before_commit=delay:200",
    });
    await waitFor(async () => (await db.app`select count(*)::int as n from outbox_messages where published_at is not null`)[0].n > 0, 20_000);
    const started = Date.now();
    app.kill("SIGTERM");
    expect(await app.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(await backlog()).toBeGreaterThan(0); // the rest stays for the next instance
  }, 90_000);

  it("with pending reversals stuck on a locked wallet, the pending worker stops after the candidate in flight and the exit code is 0", async () => {
    // base delay of 1 ms: all 20 are already due when the worker starts, so they all land in its first batch
    const writer = await startApp(db, { env: { ...queues.env, PENDING_REFERENCE_BASE_DELAY_MS: "1" } });
    const playerId = crypto.randomUUID();
    let walletId = "";
    try {
      walletId = await createWallet(writer.baseUrl, "100.00", playerId);
      for (let i = 0; i < 20; i++) {
        const r = await postWager(writer.baseUrl, {
          walletId,
          playerId,
          kind: "REFUND",
          amount: "1.00",
          referenceExternalTransactionId: `never-${crypto.randomUUID()}`,
        });
        expect(r.status).toBe(202);
      }
    } finally {
      await writer.close();
    }
    const lock = await holdWalletLock(db.owner, walletId);
    try {
      const app = await spawnApp({
        ...env(),
        ENABLE_SQS_CONSUMER: "false",
        ENABLE_PENDING_WORKER: "true",
        PENDING_REFERENCE_BASE_DELAY_MS: "1",
        PENDING_POLL_MS: "50",
        LOCK_TIMEOUT_MS: "2000",
      });
      await waitFor(async () => (await backendsWaitingOnLock(db.app)) >= 1, 15_000);
      const started = Date.now();
      app.kill("SIGTERM");
      expect(await app.exited).toBe(0);
      expect(Date.now() - started).toBeLessThan(6_000); // one lock wait (2 s), not 20 of them
    } finally {
      await lock.release();
    }
  }, 90_000);
});
