import type { SQL } from "bun";
import { expect } from "bun:test";
import { expectWalletConsistent } from "./test-db";

/**
 * Global end state after a chaotic run (multi-instance, restarts):
 *  - every wallet: stored balance == ledger, no hole in the chain;
 *  - every balance-affecting PROCESSED transaction has exactly one entry, nothing else has any;
 *  - each (provider, external id) exists at most once (no duplicated effect);
 *  - stored balance == opening + Σ(processed effects), recomputed from the transactions.
 */
export async function expectGlobalConsistency(sql: SQL, walletIds: string[]): Promise<void> {
  for (const id of walletIds) await expectWalletConsistent(sql, id);

  const [orphans] = await sql`
    select count(*)::int as n from wager_transactions t
     where t.wallet_id in ${sql(walletIds)}
       and ((t.status = 'PROCESSED' and t.kind <> 'LOSS' and t.amount > 0) <>
            exists (select 1 from wallet_ledger_entries l where l.transaction_id = t.id))`;
  expect(orphans.n).toBe(0);

  const [dups] = await sql`
    select count(*)::int as n from (
      select provider_id, external_transaction_id from wager_transactions
       group by 1, 2 having count(*) > 1) d`;
  expect(dups.n).toBe(0);

  const rows = await sql`
    select w.id, w.balance::text as stored,
           coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as from_ledger,
           (select count(*)::int from wager_transactions t where t.wallet_id = w.id and t.status = 'PROCESSED'
               and t.kind <> 'LOSS' and t.amount > 0) as affecting
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
     where w.id in ${sql(walletIds)}
     group by w.id`;
  for (const r of rows) {
    expect(r.from_ledger).toBe(r.stored);
    const [e] = await sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${r.id}`;
    expect(e.n).toBe(r.affecting);
  }
}

/** HTTP client that behaves like a provider: same key and body until a final answer, across instances. */
export async function submitUntilFinal(
  baseUrls: () => string[],
  key: string,
  body: unknown,
  deadlineMs = 30_000,
): Promise<{ status: number; body: any }> {
  const end = Date.now() + deadlineMs;
  let attempt = 0;
  for (;;) {
    const urls = baseUrls();
    const url = urls[attempt++ % urls.length]!;
    try {
      const res = await fetch(`${url}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
      const parsed = await res.json();
      // a real provider may also resend a 500 (ARCHITECTURE §10.2), but here a 500 is a bug: return it so the test sees it
      if (res.status !== 503) return { status: res.status, body: parsed };
    } catch {
      // instance down or connection dropped mid-flight: unknown outcome, retry the same request
    }
    if (Date.now() > end) throw new Error(`no final answer for ${key}`);
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
  }
}
