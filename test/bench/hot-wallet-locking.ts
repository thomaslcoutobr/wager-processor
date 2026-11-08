/**
 * Pessimistic lock vs atomic conditional UPDATE on a hot wallet (ARCHITECTURE §7.3).
 * Run inside the compose network: `docker compose run --rm tests bun test/bench/hot-wallet-locking.ts`
 *
 * Method: a scratch table in a throwaway database, one row, N concurrent debits of 1.00 over a pool
 * of 10 connections, the same work in both modes (debit + one appended row), rounds alternating to
 * spread noise; the report is the median per mode. Only the ratio matters, not the absolute number.
 *  - pessimistic: BEGIN; SELECT … FOR UPDATE; check in code; UPDATE; INSERT; COMMIT (what the app does)
 *  - atomic:      BEGIN; UPDATE … SET balance = balance - 1 WHERE balance >= 1 RETURNING; INSERT; COMMIT
 */
import { SQL } from "bun";
import { createTestDb } from "../helpers/test-db";

const N = Number(process.env.BENCH_N ?? 500);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);

const db = await createTestDb("benchlock");
const sql = new SQL({ url: db.ownerUrl, max: 10 });
await sql`create table bench_wallet (id int primary key, balance numeric(20,2) not null check (balance >= 0))`;
await sql`create table bench_entry (id bigserial primary key, wallet_id int not null, amount numeric(20,2) not null)`;

async function pessimistic(): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [w] = await tx`select balance from bench_wallet where id = 1 for update`;
    if (Number(w.balance) < 1) return false;
    await tx`update bench_wallet set balance = balance - 1 where id = 1`;
    await tx`insert into bench_entry (wallet_id, amount) values (1, 1)`;
    return true;
  });
}

async function atomic(): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx`update bench_wallet set balance = balance - 1 where id = 1 and balance >= 1 returning balance`;
    if (rows.length === 0) return false;
    await tx`insert into bench_entry (wallet_id, amount) values (1, 1)`;
    return true;
  });
}

async function round(op: () => Promise<boolean>): Promise<number> {
  await sql`delete from bench_wallet`;
  await sql`insert into bench_wallet values (1, ${N})`;
  const t0 = performance.now();
  const ok = (await Promise.all(Array.from({ length: N }, op))).filter(Boolean).length;
  const ms = performance.now() - t0;
  const [w] = await sql`select balance::text as b from bench_wallet where id = 1`;
  if (ok !== N || w.b !== "0.00") throw new Error(`expected ${N} debits and balance 0.00, got ${ok} and ${w.b}`);
  return ms;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const results: Record<"pessimistic" | "atomic", number[]> = { pessimistic: [], atomic: [] };
try {
  await round(pessimistic); // warm-up
  for (let i = 0; i < ROUNDS; i++) {
    results.pessimistic.push(await round(pessimistic));
    results.atomic.push(await round(atomic));
  }
  const p = median(results.pessimistic);
  const a = median(results.atomic);
  console.log(`N=${N} rounds=${ROUNDS} pool=10`);
  console.log(`pessimistic median ${p.toFixed(0)} ms  (${results.pessimistic.map((x) => x.toFixed(0)).join(", ")})`);
  console.log(`atomic      median ${a.toFixed(0)} ms  (${results.atomic.map((x) => x.toFixed(0)).join(", ")})`);
  console.log(`ratio pessimistic/atomic = ${(p / a).toFixed(2)}x`);
} finally {
  await sql.close();
  await db.drop();
}
