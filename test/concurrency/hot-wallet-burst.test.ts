import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, postWager, type RunningApp, startApp } from "../helpers/app";
import { backendsWaitingOnLock, holdWalletLock, waitFor } from "../helpers/locks";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

// L-01 (lente e): an HTTP burst on ONE wallet bigger than the pool. Every waiting request holds a pool
// connection until it gets the row lock or hits lock_timeout, so the burst can starve the pool. This
// file measures what the rest of the instance sees meanwhile and pins it: nothing hangs past the
// timeouts, nothing answers 500, and everything recovers once the lock is gone.

const POOL = 10;
const BURST = 40;
const LOCK_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 2_000;

let db: TestDb;
let running: RunningApp;

beforeAll(async () => {
  db = await createTestDb("burst");
  running = await startApp(db, {
    env: {
      DB_POOL_MAX: String(POOL),
      LOCK_TIMEOUT_MS: String(LOCK_TIMEOUT_MS),
      DB_CONNECT_TIMEOUT_MS: String(CONNECT_TIMEOUT_MS),
      DB_QUERY_TIMEOUT_MS: "10000",
    },
  });
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

async function timed<T>(p: Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await p;
  return { value, ms: Math.round(performance.now() - t0) };
}

describe("HTTP burst on one hot wallet bigger than the pool (L-01)", () => {
  it("another wallet and /health/ready answer within the timeouts, never 500, and all recover after the lock", async () => {
    const playerA = crypto.randomUUID();
    const walletA = await createWallet(running.baseUrl, "1000.00", playerA);
    const playerB = crypto.randomUUID();
    const walletB = await createWallet(running.baseUrl, "1000.00", playerB);

    const lock = await holdWalletLock(db.owner, walletA);
    const burst = Array.from({ length: BURST }, () =>
      timed(postWager(running.baseUrl, { walletId: walletA, playerId: playerA, amount: "1.00" })),
    );
    // the whole pool is waiting on the row lock of wallet A
    await waitFor(async () => (await backendsWaitingOnLock(db.owner)) >= POOL, 10_000);

    // probed together while the lock is still held (released only after all three answered)
    const [otherWallet, ready, live] = await Promise.all([
      timed(postWager(running.baseUrl, { walletId: walletB, playerId: playerB, amount: "1.00" })),
      timed(fetch(`${running.baseUrl}/health/ready`)),
      timed(fetch(`${running.baseUrl}/health/live`)),
    ]);

    await lock.release();
    const results = await Promise.all(burst);

    const burstStatuses = results.map((r) => r.value.status);
    const summary = {
      otherWallet: { status: otherWallet.value.status, code: otherWallet.value.body?.code, ms: otherWallet.ms },
      ready: { status: ready.value.status, ms: ready.ms },
      live: { status: live.value.status, ms: live.ms },
      burst: burstStatuses.reduce<Record<number, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {}),
      burstMaxMs: Math.max(...results.map((r) => r.ms)),
    };
    console.log(`[L-01] ${JSON.stringify(summary)}`);

    // measured 3/3 on 08/11 (pool 10, burst 40): B 503 in ~2.0 s, ready 503 in ~1.0 s, live 200,
    // burst 10x200 + 30x503. Bounds below leave margin; the exact split of the burst is not pinned.
    // The instance sheds load honestly: another wallet gets a retryable 503 within the connect
    // timeout (never a hang, never a 500) and readiness reports the starved pool.
    expect(otherWallet.value.status).toBe(503);
    expect(otherWallet.value.body.code).toBe("DATABASE_UNAVAILABLE");
    expect(otherWallet.value.headers.get("retry-after")).toBe("1");
    expect(otherWallet.ms).toBeLessThan(CONNECT_TIMEOUT_MS + 1_500);
    expect(ready.value.status).toBe(503);
    expect(ready.ms).toBeLessThan(2_500);
    expect(live.value.status).toBe(200);
    expect(live.ms).toBeLessThan(1_000);

    expect(burstStatuses.every((s) => s === 200 || s === 503)).toBe(true);
    expect(burstStatuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(summary.burstMaxMs).toBeLessThan(LOCK_TIMEOUT_MS + 3_000);
    // a 503 left nothing behind: one debit per 200
    const [debits] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletA} and direction = 'DEBIT'`;
    expect(debits.n).toBe(burstStatuses.filter((s) => s === 200).length);

    // recovery once the lock is gone
    const afterB = await postWager(running.baseUrl, { walletId: walletB, playerId: playerB, amount: "1.00" });
    expect(afterB.status).toBe(200);
    await waitFor(async () => (await fetch(`${running.baseUrl}/health/ready`)).status === 200, 5_000);

    await expectWalletConsistent(db.app, walletA);
    await expectWalletConsistent(db.app, walletB);
  }, 60_000);
});
