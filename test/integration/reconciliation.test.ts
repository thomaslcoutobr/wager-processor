import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, postWager, type RunningApp, startApp } from "../helpers/app";
import { createTestDb, type TestDb } from "../helpers/test-db";

let db: TestDb;
let running: RunningApp;
let base: string;

beforeAll(async () => {
  db = await createTestDb("recon");
  running = await startApp(db);
  base = running.baseUrl;
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

describe("POST /wallets/:id/reconciliation", () => {
  it("rebuilds the balance from the ledger and reports it consistent", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(base, "1000.00", playerId);
    await postWager(base, { walletId, playerId, amount: "25.00" });
    await postWager(base, { walletId, playerId, kind: "WIN", amount: "0.10" });
    await postWager(base, { walletId, playerId, kind: "LOSS", amount: "3.00" });
    const r = await call(base, "POST", `/wallets/${walletId}/reconciliation`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      walletId,
      storedBalance: { amount: "975.10", currency: "BRL" },
      calculatedBalance: { amount: "975.10", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 3,
      chainBreaks: 0,
    });
  });

  it("a wallet with no entries is consistent at 0.00", async () => {
    const walletId = await createWallet(base, "0.00");
    const r = await call(base, "POST", `/wallets/${walletId}/reconciliation`);
    expect(r.body).toMatchObject({ consistent: true, checkedEntries: 0, calculatedBalance: { amount: "0.00" } });
  });

  it("a divergence made by a privileged role is reported (never fixed), logged and counted", async () => {
    const playerId = crypto.randomUUID();
    const walletId = await createWallet(base, "100.00", playerId);
    db.excludeFromInvariant(walletId); // tampered on purpose: the suite invariant must not count it
    // only the owner/superuser can do this: switch the guard off and tamper with the balance
    await db.owner.unsafe(`alter table wallets disable trigger wallet_change_is_backed`);
    try {
      await db.owner`update wallets set balance = 150.00 where id = ${walletId}`;
    } finally {
      await db.owner.unsafe(`alter table wallets enable trigger wallet_change_is_backed`);
    }
    const r = await call(base, "POST", `/wallets/${walletId}/reconciliation`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      consistent: false,
      storedBalance: { amount: "150.00" },
      calculatedBalance: { amount: "100.00" },
      difference: { amount: "50.00" },
    });
    // not corrected silently
    expect((await call(base, "GET", `/wallets/${walletId}`)).body.balance.amount).toBe("150.00");
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toMatch(/reconciliation_divergence_total 1/);
  });

  it("404 for an unknown wallet", async () => {
    expect((await call(base, "POST", `/wallets/${crypto.randomUUID()}/reconciliation`)).status).toBe(404);
  });
});
