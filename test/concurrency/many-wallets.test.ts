import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, gate, postWager, type RunningApp, startApp } from "../helpers/app";
import { holdWalletLock } from "../helpers/locks";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

let db: TestDb;
let running: RunningApp;

beforeAll(async () => {
  db = await createTestDb("many");
  running = await startApp(db, { env: { DB_POOL_MAX: "20" } });
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

describe("different wallets in parallel", () => {
  it("20 wallets × 6 concurrent operations each end exactly where they should", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const playerId = crypto.randomUUID();
        return { playerId, walletId: await createWallet(running.baseUrl, "100.00", playerId) };
      }),
    );
    const g = gate();
    const ops = wallets.flatMap(({ walletId, playerId }) => [
      ...Array.from({ length: 4 }, async () => {
        await g.wait;
        return postWager(running.baseUrl, { walletId, playerId, kind: "BET", amount: "10.00" });
      }),
      (async () => {
        await g.wait;
        return postWager(running.baseUrl, { walletId, playerId, kind: "WIN", amount: "5.50" });
      })(),
      (async () => {
        await g.wait;
        return postWager(running.baseUrl, { walletId, playerId, kind: "LOSS", amount: "3.00" });
      })(),
    ]);
    g.open();
    const res = await Promise.all(ops);
    expect(res.every((r) => r.status === 200)).toBe(true);
    for (const { walletId } of wallets) {
      const w = (await call(running.baseUrl, "GET", `/wallets/${walletId}`)).body;
      expect(w.balance.amount).toBe("65.50");
      expect(w.version).toBe(6);
      await expectWalletConsistent(db.app, walletId);
    }
  });

  it("a locked wallet does not block another wallet (no global lock)", async () => {
    const pa = crypto.randomUUID();
    const pb = crypto.randomUUID();
    const a = await createWallet(running.baseUrl, "100.00", pa);
    const b = await createWallet(running.baseUrl, "100.00", pb);
    const lock = await holdWalletLock(db.owner, a);
    let aDone = false;
    const onA = postWager(running.baseUrl, { walletId: a, playerId: pa }).then((r) => {
      aDone = true;
      return r;
    });
    try {
      const t0 = performance.now();
      const onB = await postWager(running.baseUrl, { walletId: b, playerId: pb });
      expect(onB.status).toBe(200);
      expect(performance.now() - t0).toBeLessThan(2_000);
      expect(aDone).toBe(false);
    } finally {
      await lock.release();
    }
    expect((await onA).status).toBe(200);
  });
});
