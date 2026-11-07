import { SQL } from "bun";
import { expect } from "bun:test";
import { migrateDown, migrateUp } from "../../src/infrastructure/persistence/migrate";

/** The role the application connects with (created idempotently by the first migration). */
export const APP_ROLE = { user: "wager_app", password: "wager_app" };

export interface TestDb {
  name: string;
  /** Owner of the tables (runs migrations). In the postgres image it is also a superuser. */
  ownerUrl: string;
  /** Least-privilege role the application uses. */
  appUrl: string;
  owner: SQL;
  app: SQL;
  drop(): Promise<void>;
}

function withDatabase(url: string, database: string, creds?: { user: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (creds) {
    u.username = creds.user;
    u.password = creds.password;
  }
  return u.toString();
}

function adminUrl(): string {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is required for integration tests (run them with `docker compose run --rm tests`)");
  return url;
}

/** A fresh database per test file (one per `bun test --parallel` worker), migrated to the latest version. */
export async function createTestDb(label: string, opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const name = `t_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${process.env.BUN_TEST_WORKER_ID ?? "0"}_${Date.now().toString(36)}`;
  const admin = new SQL(adminUrl());
  await admin.unsafe(`create database "${name}"`);
  await admin.close();
  const ownerUrl = withDatabase(adminUrl(), name);
  const appUrl = withDatabase(adminUrl(), name, APP_ROLE);
  if (opts.migrate !== false) await migrateUp(ownerUrl);
  const owner = new SQL(ownerUrl);
  const app = new SQL(appUrl);
  return {
    name,
    ownerUrl,
    appUrl,
    owner,
    app,
    async drop() {
      await owner.close();
      await app.close();
      const a = new SQL(adminUrl());
      await a.unsafe(`drop database if exists "${name}" with (force)`);
      await a.close();
    },
  };
}

export { migrateDown, migrateUp };

/** Asserts the promise rejects with the given SQLSTATE (Bun's PostgresError carries it in `errno`). */
export async function expectSqlState(p: Promise<unknown>, sqlstate: string): Promise<void> {
  let error: unknown;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect((error as { errno?: string }).errno).toBe(sqlstate);
}

/** wallet.balance == balance rebuilt from the ledger, and the before/after chain has no hole. */
export async function expectWalletConsistent(sql: SQL, walletId: string): Promise<void> {
  const [row] = await sql`
    select w.balance::text as stored,
           coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as calculated,
           w.version as version,
           count(l.id)::int as entries,
           coalesce(max(l.wallet_version), 0)::int as max_version
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
     where w.id = ${walletId}
     group by w.id`;
  expect(row).toBeDefined();
  expect(row.calculated).toBe(row.stored);
  const [chain] = await sql`
    select count(*)::int as breaks from (
      select balance_before, lag(balance_after) over (order by wallet_version) as prev_after,
             wallet_version, lag(wallet_version) over (order by wallet_version) as prev_version
        from wallet_ledger_entries where wallet_id = ${walletId}) c
     where prev_after is not null and (balance_before <> prev_after or wallet_version <> prev_version + 1)`;
  expect(chain.breaks).toBe(0);
}
