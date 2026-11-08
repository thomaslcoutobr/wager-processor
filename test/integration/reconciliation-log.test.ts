import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call } from "../helpers/app";
import { type SpawnedApp, spawnApp } from "../helpers/spawn";
import { createTestDb, type TestDb } from "../helpers/test-db";

// Ld-02: a reconciliation divergence is logged at error level with the ids, and the line keeps the
// rule of every log line (ARCHITECTURE §17): no money amounts. The amounts are in the response.

let db: TestDb;
let app: SpawnedApp;
let walletId = "";

beforeAll(async () => {
  db = await createTestDb("recon_log");
  app = await spawnApp({
    DATABASE_URL: db.appUrl,
    ENABLE_SQS_CONSUMER: "false",
    ENABLE_OUTBOX_PUBLISHER: "false",
    ENABLE_PENDING_WORKER: "false",
  });
  const w = await call(app.baseUrl, "POST", "/wallets", { playerId: crypto.randomUUID(), initialBalance: { amount: "100.00", currency: "BRL" } });
  walletId = w.body.id as string;
  db.excludeFromInvariant(walletId); // tampered on purpose
  await db.owner.unsafe("alter table wallets disable trigger wallet_change_is_backed");
  try {
    await db.owner`update wallets set balance = 150.00 where id = ${walletId}`;
  } finally {
    await db.owner.unsafe("alter table wallets enable trigger wallet_change_is_backed");
  }
});
afterAll(async () => {
  app?.kill("SIGTERM");
  await app?.exited;
  await db?.drop();
});

describe("reconciliation divergence log (Ld-02)", () => {
  it("is an error line with the wallet id and the chain breaks, and carries no amount", async () => {
    const r = await call(app.baseUrl, "POST", `/wallets/${walletId}/reconciliation`);
    expect(r.body).toMatchObject({ consistent: false, difference: { amount: "50.00" } });
    const line = await app.waitForLine(/"msg":"reconciliation divergence"/);
    expect(JSON.parse(line)).toMatchObject({ level: "error", walletId, chainBreaks: 0 });
    expect(line).not.toContain("150.00");
    expect(line).not.toContain("100.00");
    expect(line).not.toContain("50.00");
  });
});
