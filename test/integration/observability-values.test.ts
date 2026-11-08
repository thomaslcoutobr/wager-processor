import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, wagerBody } from "../helpers/app";
import { holdWalletLock, waitFor } from "../helpers/locks";
import { spawnApp, type SpawnedApp } from "../helpers/spawn";
import { createTestQueues, requestedEnvelope, sendRaw, type TestQueues } from "../helpers/sqs";
import { createTestDb, type TestDb } from "../helpers/test-db";

// The other observability file proves the metric families exist; this one proves they MOVE with
// what happened, and that the queue path logs the envelope messageId.

let db: TestDb;
let queues: TestQueues;
let app: SpawnedApp;

beforeAll(async () => {
  db = await createTestDb("obsvalues");
  queues = await createTestQueues("obsvalues");
  app = await spawnApp({
    ...queues.env,
    DATABASE_URL: db.appUrl,
    ENABLE_SQS_CONSUMER: "true",
    ENABLE_OUTBOX_PUBLISHER: "false",
    ENABLE_PENDING_WORKER: "false",
    LOCK_TIMEOUT_MS: "300",
  });
});
afterAll(async () => {
  app?.kill("SIGTERM");
  await app?.exited;
  await db?.drop();
});

/** Sum of the samples of `name` whose labels include every pair of `labels` (Prometheus text format). */
function sample(text: string, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const line of text.split("\n")) {
    const m = /^([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})? (\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const got = Object.fromEntries([...(m[2] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((p) => [p[1], p[2]]));
    if (Object.entries(labels).every(([k, v]) => got[k] === v)) total += Number(m[3]);
  }
  return total;
}
const metrics = async () => (await fetch(`${app.baseUrl}/metrics`)).text();

async function newWallet(amount: string) {
  const playerId = crypto.randomUUID();
  const w = await call(app.baseUrl, "POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  expect(w.status).toBe(201);
  return { walletId: w.body.id as string, playerId };
}

describe("metric values follow the outcomes", () => {
  it("wager_transactions_total counts by status/kind/source and wager_processing_seconds counts every submission", async () => {
    const w = await newWallet("10.00");
    const before = await metrics();
    const ok = wagerBody({ ...w, amount: "4.00" });
    const post = (b: typeof ok) => call(app.baseUrl, "POST", "/wagering/transactions", b.body, { "Idempotency-Key": b.key });
    expect((await post(ok)).status).toBe(200);
    expect((await post(wagerBody({ ...w, amount: "50.00" }))).status).toBe(422); // insufficient funds
    expect((await post(ok)).body.idempotentReplay).toBe(true);
    const after = await metrics();

    const delta = (name: string, labels: Record<string, string> = {}) => sample(after, name, labels) - sample(before, name, labels);
    expect(delta("wager_transactions_total", { status: "PROCESSED", kind: "BET", source: "http" })).toBe(1);
    expect(delta("wager_transactions_total", { status: "REJECTED", kind: "BET", source: "http" })).toBe(1);
    expect(delta("wager_transactions_total")).toBe(2); // the replay decides nothing
    expect(delta("wager_duplicates_total", { source: "http", kind: "idempotency" })).toBe(1);
    expect(delta("wager_processing_seconds_count", { source: "http" })).toBe(3);
    expect(delta("wager_processing_seconds_sum", { source: "http" })).toBeGreaterThan(0);
  });

  it("db_lock_conflicts_total counts a lock timeout under its SQLSTATE", async () => {
    const w = await newWallet("10.00");
    const before = sample(await metrics(), "db_lock_conflicts_total", { sqlstate: "55P03" });
    const lock = await holdWalletLock(db.owner, w.walletId);
    let status: number;
    try {
      const b = wagerBody({ ...w, amount: "1.00" });
      status = (await call(app.baseUrl, "POST", "/wagering/transactions", b.body, { "Idempotency-Key": b.key })).status;
    } finally {
      await lock.release();
    }
    expect(status).toBe(503);
    expect(sample(await metrics(), "db_lock_conflicts_total", { sqlstate: "55P03" }) - before).toBe(1);
  });
});

describe("queue path logs", () => {
  it("carry the SQS message id and, once the envelope is read, its messageId; the counters move with source sqs", async () => {
    const w = await newWallet("100.00");
    const before = await metrics();
    const { key, body } = wagerBody({ ...w, amount: "6.00" });
    const env = requestedEnvelope({ ...body, idempotencyKey: key });
    await sendRaw(queues.urls.main, JSON.stringify(env), w.walletId);
    await waitFor(async () => (await call(app.baseUrl, "GET", `/wallets/${w.walletId}`)).body.balance.amount === "94.00", 10_000);
    // redelivery of the same envelope: answered by the inbox, and that line names the messageId
    await sendRaw(queues.urls.main, JSON.stringify(env), w.walletId);
    const dupLine = await app.waitForLine(new RegExp(`"msg":"inbox duplicate".*"messageId":"${env.messageId}"|"messageId":"${env.messageId}".*"msg":"inbox duplicate"`));
    const dup = JSON.parse(dupLine);
    expect(dup).toMatchObject({ messageId: env.messageId, walletId: w.walletId, providerId: "provider-a" });
    expect(typeof dup.sqsMessageId).toBe("string");

    const processing = app.lines.filter((l) => l.includes('"processing message"')).map((l) => JSON.parse(l));
    expect(processing.filter((l) => typeof l.sqsMessageId === "string").length).toBeGreaterThanOrEqual(2);
    expect(app.lines.join("\n")).not.toContain('"6.00"');

    await waitFor(async () => sample(await metrics(), "wager_duplicates_total", { source: "sqs", kind: "inbox" }) > sample(before, "wager_duplicates_total", { source: "sqs", kind: "inbox" }), 10_000);
    const after = await metrics();
    expect(sample(after, "wager_transactions_total", { status: "PROCESSED", kind: "BET", source: "sqs" })
      - sample(before, "wager_transactions_total", { status: "PROCESSED", kind: "BET", source: "sqs" })).toBe(1);
    expect(sample(after, "wager_processing_seconds_count", { source: "sqs" })
      - sample(before, "wager_processing_seconds_count", { source: "sqs" })).toBe(2);
  });
});
