import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, wagerBody } from "../helpers/app";
import { waitFor } from "../helpers/locks";
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
});
