import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, startApp, wagerBody } from "../helpers/app";
import { spawnApp, type SpawnedApp } from "../helpers/spawn";
import { createTestDb, type TestDb } from "../helpers/test-db";

let db: TestDb;
let app: SpawnedApp;

beforeAll(async () => {
  db = await createTestDb("obs");
  app = await spawnApp({
    DATABASE_URL: db.appUrl,
    ENABLE_SQS_CONSUMER: "false",
    ENABLE_OUTBOX_PUBLISHER: "false",
    ENABLE_PENDING_WORKER: "false",
  });
});
afterAll(async () => {
  app?.kill("SIGTERM");
  await app?.exited;
  await db?.drop();
});

describe("structured logs", () => {
  it("carry correlationId, transactionId, walletId and providerId, and never the payload", async () => {
    const playerId = crypto.randomUUID();
    const w = await call(app.baseUrl, "POST", "/wallets", { playerId, initialBalance: { amount: "777.77", currency: "BRL" } });
    const { key, body } = wagerBody({ walletId: w.body.id, playerId, amount: "12.34" });
    const r = await call(app.baseUrl, "POST", "/wagering/transactions", body, {
      "Idempotency-Key": key,
      "X-Correlation-Id": "corr-obs-1",
      Authorization: "Bearer secret-token-xyz",
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-correlation-id")).toBe("corr-obs-1");
    const line = await app.waitForLine(/"correlationId":"corr-obs-1".*"status":200|"status":200.*"correlationId":"corr-obs-1"/);
    const log = JSON.parse(line);
    expect(log).toMatchObject({
      level: "info",
      correlationId: "corr-obs-1",
      walletId: w.body.id,
      providerId: "provider-a",
      transactionId: r.body.transactionId,
      method: "POST",
      route: "/wagering/transactions",
      status: 200,
    });
    expect(typeof log.durationMs).toBe("number");
    const all = app.lines.join("\n");
    expect(all).not.toContain("12.34");
    expect(all).not.toContain("777.77");
    expect(all).not.toContain("secret-token-xyz");
    expect(all).not.toContain(playerId);
  });

  it("every line is JSON", () => {
    for (const l of app.lines.filter((x) => x.trim())) expect(() => JSON.parse(l)).not.toThrow();
  });
});

describe("metrics and health", () => {
  it("/metrics exposes every required family", async () => {
    const text = await (await fetch(`${app.baseUrl}/metrics`)).text();
    for (const name of [
      "wager_transactions_total",
      "wager_duplicates_total",
      "sqs_retries_total",
      "db_transaction_retries_total",
      "sqs_dlq_total",
      "db_lock_conflicts_total",
      "wallet_lock_wait_seconds",
      "outbox_lag_seconds",
      "outbox_pending",
      "wager_processing_seconds",
    ]) {
      expect(text).toContain(`# TYPE ${name}`);
    }
  });

  it("liveness and readiness are separate; readiness fails when SQS is unreachable", async () => {
    expect((await fetch(`${app.baseUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${app.baseUrl}/health/ready`)).status).toBe(200);
    const broken = await startApp(db, { env: { SQS_ENDPOINT: "http://127.0.0.1:1" } });
    try {
      expect((await fetch(`${broken.baseUrl}/health/live`)).status).toBe(200);
      const ready = await fetch(`${broken.baseUrl}/health/ready`);
      expect(ready.status).toBe(503);
      const body = (await ready.json()) as { checks: Record<string, string> };
      expect(body.checks.postgres).toBe("ok");
      expect(body.checks.sqs).toStartWith("fail");
    } finally {
      await broken.close();
    }
  });
});
