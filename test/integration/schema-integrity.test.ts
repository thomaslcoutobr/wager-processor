// Schema integrity from the 2nd review round (Migration20261108000200_trigger_integrity, ARCHITECTURE §6.5),
// all as wager_app, the application role, with raw SQL (the API and the queue cannot reach these paths):
//  - R2a-01/R2c-01 a late OPENING cannot fill version 1 of a wallet opened with 0.00;
//  - R2c-02 a temporary table cannot shadow the tables the deferred triggers read;
//  - R2c-03 result_currency is the wallet currency.
// Attacked wallets leave the drop() invariant (excludeFromInvariant), or the drop() would hide the result.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { createTestDb, expectSqlState, type TestDb } from "../helpers/test-db";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb("r2c_schema");
});
afterAll(async () => {
  await db?.drop();
});

async function seedWallet(sql: SQL, balance = "100.00"): Promise<{ walletId: string; playerId: string; openingId: string }> {
  const walletId = crypto.randomUUID();
  const playerId = `p-${walletId}`;
  const openingId = crypto.randomUUID();
  await sql.begin(async (tx) => {
    await tx`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
             values (${walletId}, ${playerId}, 'BRL', ${balance}::numeric, 1, now(), now())`;
    if (balance === "0.00") return;
    await tx`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
               wallet_id, player_id, kind, amount, currency, status, result_balance, result_currency, created_at, processed_at)
             values (${openingId}, '__internal__', ${"opening:" + walletId}, ${"opening:" + walletId}, 'internal:opening',
               ${walletId}, ${playerId}, 'OPENING', ${balance}::numeric, 'BRL', 'PROCESSED', ${balance}::numeric, 'BRL', now(), now())`;
    await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
               balance_before, balance_after, wallet_version, created_at)
             values (${crypto.randomUUID()}, ${walletId}, ${openingId}, 'CREDIT', ${balance}::numeric, 'BRL', 0, ${balance}::numeric, 1, now())`;
  });
  return { walletId, playerId, openingId };
}

/** An OPENING row exactly like CreateWallet would write it (provider __internal__, external id opening:<walletId>). */
function insertProcessedOpening(sql: SQL, walletId: string, id: string, amount: string, externalId = `opening:${walletId}`) {
  return sql`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
      wallet_id, player_id, kind, amount, currency, status, result_balance, result_currency, created_at, processed_at)
    values (${id}, '__internal__', ${externalId}, ${externalId}, 'internal:opening',
      ${walletId}, ${"p-" + walletId}, 'OPENING', ${amount}::numeric, 'BRL', 'PROCESSED', ${amount}::numeric, 'BRL', now(), now())`;
}

async function reconcileSql(sql: SQL, walletId: string) {
  const [r] = await sql`
    select w.balance::text as stored, w.version,
           coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as calculated,
           count(l.id)::int as entries
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
     where w.id = ${walletId} group by w.id`;
  return r as { stored: string; version: number; calculated: string; entries: number };
}

async function commitRefused(p: Promise<unknown>): Promise<{ refused: boolean; errno?: string }> {
  try {
    await p;
    return { refused: false };
  } catch (e) {
    return { refused: true, errno: (e as { errno?: string }).errno };
  }
}

describe("R2a-01/R2c-01 phantom OPENING entry at version 1 of a wallet opened with 0.00", () => {
  it("a fresh PROCESSED OPENING + CREDIT at v1, without the wallet UPDATE, fails at commit", async () => {
    const { walletId } = await seedWallet(db.app, "0.00");
    db.excludeFromInvariant(walletId);
    const openingId = crypto.randomUUID();
    const outcome = await commitRefused(
      db.app.begin(async (tx) => {
        await insertProcessedOpening(tx as unknown as SQL, walletId, openingId, "500.00");
        await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                   balance_before, balance_after, wallet_version, created_at)
                 values (${crypto.randomUUID()}, ${walletId}, ${openingId}, 'CREDIT', 500, 'BRL', 0, 500, 1, now())`;
      }),
    );
    const r = await reconcileSql(db.app, walletId);
    // ARCHITECTURE §6.5: no free version is left for an entry without its wallet change
    expect({ refused: outcome.refused, stored: r.stored, calculated: r.calculated }).toEqual({
      refused: true,
      stored: "0.00",
      calculated: "0.00",
    });
  });

  it("the same phantom OPENING is refused after the 0.00 wallet has moved to v2", async () => {
    const { walletId, playerId } = await seedWallet(db.app, "0.00");
    db.excludeFromInvariant(walletId);
    // a legit WIN of 50.00: v1 -> v2, 0 -> 50, with its entry
    const winId = crypto.randomUUID();
    await db.app.begin(async (tx) => {
      await tx`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
                 wallet_id, player_id, round_id, game_id, kind, amount, currency, status, result_balance, result_currency,
                 created_at, processed_at)
               values (${winId}, 'provider-a', ${"ext-" + winId}, ${"k-" + winId}, 'v1:sha256:x', ${walletId}, ${playerId},
                 'round-1', 'game-1', 'WIN', 50, 'BRL', 'PROCESSED', 50, 'BRL', now(), now())`;
      await tx`update wallets set balance = 50, version = 2, updated_at = now() where id = ${walletId}`;
      await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                 balance_before, balance_after, wallet_version, created_at)
               values (${crypto.randomUUID()}, ${walletId}, ${winId}, 'CREDIT', 50, 'BRL', 0, 50, 2, now())`;
    });
    const before = await reconcileSql(db.app, walletId);
    expect(before).toEqual({ stored: "50.00", version: 2, calculated: "50.00", entries: 1 });

    const openingId = crypto.randomUUID();
    const outcome = await commitRefused(
      db.app.begin(async (tx) => {
        await insertProcessedOpening(tx as unknown as SQL, walletId, openingId, "500.00");
        await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                   balance_before, balance_after, wallet_version, created_at)
                 values (${crypto.randomUUID()}, ${walletId}, ${openingId}, 'CREDIT', 500, 'BRL', 0, 500, 1, now())`;
      }),
    );
    const r = await reconcileSql(db.app, walletId);
    expect({ refused: outcome.refused, stored: r.stored, calculated: r.calculated }).toEqual({
      refused: true,
      stored: "50.00",
      calculated: "50.00",
    });
  });

  it("on a wallet opened with 100.00 the v1 slot is taken (23505)", async () => {
    const { walletId } = await seedWallet(db.app, "100.00");
    const openingId = crypto.randomUUID();
    await expectSqlState(
      db.app.begin(async (tx) => {
        await insertProcessedOpening(tx as unknown as SQL, walletId, openingId, "500.00", `opening2:${walletId}`);
        await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                   balance_before, balance_after, wallet_version, created_at)
                 values (${crypto.randomUUID()}, ${walletId}, ${openingId}, 'CREDIT', 500, 'BRL', 0, 500, 1, now())`;
      }),
      "23505",
    );
  });

  it("an OPENING entry outside v1 is refused (P0001)", async () => {
    const { walletId } = await seedWallet(db.app, "100.00");
    const openingId = crypto.randomUUID();
    await expectSqlState(
      db.app.begin(async (tx) => {
        await insertProcessedOpening(tx as unknown as SQL, walletId, openingId, "5.00", `opening2:${walletId}`);
        await tx`update wallets set balance = 105, version = 2, updated_at = now() where id = ${walletId}`;
        await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                   balance_before, balance_after, wallet_version, created_at)
                 values (${crypto.randomUUID()}, ${walletId}, ${openingId}, 'CREDIT', 5, 'BRL', 100, 105, 2, now())`;
      }),
      "P0001",
    );
  });
});

describe("R2c-02 deferred triggers ignore temporary tables (search_path = public, pg_temp)", () => {
  // the second line of defence is tested alone: TEMPORARY is granted back to the app role for these two
  const withTemporary = async (fn: () => Promise<void>) => {
    await db.owner.unsafe(`grant temporary on database "${db.name}" to wager_app`);
    try {
      await fn();
    } finally {
      await db.owner.unsafe(`revoke temporary on database "${db.name}" from wager_app`);
    }
  };
  it("the application role has no TEMPORARY on the database", async () => {
    const [r] = await db.app`select has_database_privilege(current_user, current_database(), 'TEMPORARY') as temp`;
    expect(r.temp).toBe(false);
  });

  it("without the shadow table, a balance UPDATE with no entry is refused at commit (P0001)", async () => {
    const { walletId } = await seedWallet(db.app, "100.00");
    await expectSqlState(
      db.app.begin(async (tx) => {
        await tx`update public.wallets set balance = 1000000, version = 2, updated_at = now() where id = ${walletId}`;
      }),
      "P0001",
    );
  });

  it("even with TEMPORARY back, a temp wallet_ledger_entries does not make wallet_change_is_backed accept a balance with no entry", async () => {
    const { walletId } = await seedWallet(db.app, "100.00");
    db.excludeFromInvariant(walletId);
    const conn = new SQL({ url: db.appUrl, max: 1 });
    let outcome: { refused: boolean; errno?: string } = { refused: false };
    await withTemporary(async () => {
    try {
      outcome = await commitRefused(
        conn.begin(async (tx) => {
          await tx.unsafe(`create temp table wallet_ledger_entries (
                             wallet_id uuid, wallet_version integer, balance_before numeric, balance_after numeric)
                           `);
          await tx`insert into pg_temp.wallet_ledger_entries values (${walletId}, 2, 100, 1000000)`;
          await tx`update public.wallets set balance = 1000000, version = 2, updated_at = now() where id = ${walletId}`;
        }),
      );
    } finally {
      await conn.close();
    }
    });
    const r = await reconcileSql(db.app, walletId);
    // ARCHITECTURE §6.5: every wallet version has exactly one entry, even for the application role
    expect({ refused: outcome.refused, stored: r.stored, calculated: r.calculated }).toEqual({
      refused: true,
      stored: "100.00",
      calculated: "100.00",
    });
  });

  it("even with TEMPORARY back, a temp wager_transactions does not make ledger_entry_is_backed accept a CREDIT of a REJECTED transaction", async () => {
    const { walletId, playerId } = await seedWallet(db.app, "100.00");
    db.excludeFromInvariant(walletId);
    // a real REJECTED WIN of 400.00 (as the app records a rejection)
    const rejectedId = crypto.randomUUID();
    await db.app`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency, status, failure_code, result_balance, result_currency,
        created_at, processed_at)
      values (${rejectedId}, 'provider-a', ${"ext-" + rejectedId}, ${"k-" + rejectedId}, 'v1:sha256:x', ${walletId}, ${playerId},
        'round-1', 'game-1', 'WIN', 400, 'BRL', 'REJECTED', 'REFERENCE_MISMATCH', 100, 'BRL', now(), now())`;
    const conn = new SQL({ url: db.appUrl, max: 1 });
    let outcome: { refused: boolean; errno?: string } = { refused: false };
    await withTemporary(async () => {
    try {
      outcome = await commitRefused(
        conn.begin(async (tx) => {
          await tx.unsafe(`create temp table wager_transactions (
                             id uuid, status text, kind text, amount numeric, currency char(3), reference_transaction_id uuid)
                           `);
          await tx`insert into pg_temp.wager_transactions values (${rejectedId}, 'PROCESSED', 'WIN', 400, 'BRL', null)`;
          await tx`update public.wallets set balance = 500, version = 2, updated_at = now() where id = ${walletId}`;
          await tx`insert into public.wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                     balance_before, balance_after, wallet_version, created_at)
                   values (${crypto.randomUUID()}, ${walletId}, ${rejectedId}, 'CREDIT', 400, 'BRL', 100, 500, 2, now())`;
        }),
      );
    } finally {
      await conn.close();
    }
    });
    const [n] = await db.app`select count(*)::int as n from wallet_ledger_entries where transaction_id = ${rejectedId}`;
    const r = await reconcileSql(db.app, walletId);
    // ARCHITECTURE §6.4: a REJECTED transaction never has an entry
    expect({ refused: outcome.refused, entriesOfRejected: n.n, stored: r.stored }).toEqual({
      refused: true,
      entriesOfRejected: 0,
      stored: "100.00",
    });
  });
});

describe("R2c-03 result_currency is tied to the wallet currency", () => {
  it("a terminal row of a BRL wallet stored with result_currency USD is refused", async () => {
    const { walletId, playerId } = await seedWallet(db.app, "100.00");
    const id = crypto.randomUUID();
    const outcome = await commitRefused(
      db.app`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency, status, result_balance, result_currency,
          created_at, processed_at)
        values (${id}, 'provider-a', ${"ext-" + id}, ${"k-" + id}, 'v1:sha256:x', ${walletId}, ${playerId},
          'round-1', 'game-1', 'LOSS', 10, 'BRL', 'PROCESSED', 100, 'USD', now(), now())`,
    );
    expect(outcome.refused).toBe(true);
  });
});
