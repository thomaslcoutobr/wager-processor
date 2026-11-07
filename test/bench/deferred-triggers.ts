/**
 * Cost of the deferred balance↔ledger triggers (ARCHITECTURE §6.5) on a hot wallet.
 * Run inside the compose network: `docker compose run --rm tests bun test/bench/deferred-triggers.ts`
 *
 * Method: one in-process app, one wallet, N concurrent BETs of 1.00 (pool of 10 connections).
 * Rounds alternate triggers ON / OFF (OFF = the owner disables the two constraint triggers) to
 * spread noise; the report is the median per mode. Only the ratio matters, not the absolute number.
 */
import { createWallet, postWager, startApp } from "../helpers/app";
import { createTestDb } from "../helpers/test-db";

const N = Number(process.env.BENCH_N ?? 300);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);

const db = await createTestDb("bench");
const app = await startApp(db);

async function setTriggers(on: boolean) {
  const verb = on ? "enable" : "disable";
  await db.owner.unsafe(`alter table wallets ${verb} trigger wallet_change_is_backed`);
  await db.owner.unsafe(`alter table wallet_ledger_entries ${verb} trigger ledger_entry_is_backed`);
}

async function round(): Promise<{ ms: number; ok: number }> {
  const playerId = crypto.randomUUID();
  const walletId = await createWallet(app.baseUrl, "100000.00", playerId);
  const t0 = performance.now();
  const res = await Promise.all(Array.from({ length: N }, () => postWager(app.baseUrl, { walletId, playerId, amount: "1.00" })));
  const ms = performance.now() - t0;
  return { ms, ok: res.filter((r) => r.status === 200).length };
}

const results: Record<"on" | "off", number[]> = { on: [], off: [] };
try {
  await round(); // warm-up
  for (let i = 0; i < ROUNDS; i++) {
    for (const mode of ["on", "off"] as const) {
      await setTriggers(mode === "on");
      const r = await round();
      if (r.ok !== N) throw new Error(`expected ${N} processed, got ${r.ok}`);
      results[mode].push(r.ms);
    }
  }
} finally {
  await setTriggers(true);
  await app.close();
  await db.drop();
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const on = median(results.on);
const off = median(results.off);
console.log(
  JSON.stringify(
    {
      n: N,
      rounds: ROUNDS,
      triggersOnMs: results.on.map(Math.round),
      triggersOffMs: results.off.map(Math.round),
      medianOnMs: Math.round(on),
      medianOffMs: Math.round(off),
      opsPerSecOn: Math.round((N / on) * 1000),
      opsPerSecOff: Math.round((N / off) * 1000),
      overheadPct: Math.round(((on - off) / off) * 1000) / 10,
    },
    null,
    2,
  ),
);
process.exit(0);
