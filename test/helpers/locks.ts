import type { SQL } from "bun";

/** Waits for a condition without fixed sleeps. */
export async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 10_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

/**
 * Holds `SELECT … FOR UPDATE` on a wallet from a dedicated connection, so concurrent requests are
 * forced to queue on the row lock. `release()` rolls back and frees the connection.
 */
export async function holdWalletLock(sql: SQL, walletId: string): Promise<{ release(): Promise<void> }> {
  const conn = await sql.reserve();
  await conn`begin`;
  await conn`select id from wallets where id = ${walletId} for update`;
  return {
    async release() {
      await conn`rollback`;
      conn.release();
    },
  };
}

/** Number of backends of this database currently waiting on a lock. */
export async function backendsWaitingOnLock(sql: SQL): Promise<number> {
  const [r] = await sql`select count(*)::int as n from pg_stat_activity
                         where datname = current_database() and wait_event_type = 'Lock'`;
  return r.n as number;
}
