import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { createTestDb, expectSqlState, migrateDown, migrateUp, type TestDb } from "../helpers/test-db";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb("schema");
});
afterAll(async () => {
  await db?.drop();
});

/** A consistent wallet (+ OPENING transaction + opening CREDIT), written as the application role. */
async function seedWallet(sql: SQL, balance = "100.00"): Promise<{ walletId: string; openingId: string }> {
  const walletId = crypto.randomUUID();
  const openingId = crypto.randomUUID();
  await sql.begin(async (tx) => {
    await tx`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
             values (${walletId}, ${"p-" + walletId}, 'BRL', ${balance}::numeric, 1, now(), now())`;
    if (balance === "0.00") return; // no opening transaction or entry without balance
    await tx`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
               wallet_id, player_id, kind, amount, currency, status, result_balance, result_currency, created_at, processed_at)
             values (${openingId}, '__internal__', ${"opening:" + walletId}, ${"opening:" + walletId}, 'internal',
               ${walletId}, ${"p-" + walletId}, 'OPENING', ${balance}::numeric, 'BRL', 'PROCESSED', ${balance}::numeric, 'BRL', now(), now())`;
    await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
               balance_before, balance_after, wallet_version, created_at)
             values (${crypto.randomUUID()}, ${walletId}, ${openingId}, 'CREDIT', ${balance}::numeric, 'BRL', 0, ${balance}::numeric, 1, now())`;
  });
  return { walletId, openingId };
}

interface TxRow {
  id?: string;
  walletId: string;
  kind?: string;
  status?: string;
  amount?: string;
  providerId?: string;
  externalId?: string;
  key?: string;
  refExternal?: string | null;
  refId?: string | null;
  failureCode?: string | null;
}

function insertTx(sql: SQL, r: TxRow) {
  const id = r.id ?? crypto.randomUUID();
  const ext = r.externalId ?? `ext-${id}`;
  const status = r.status ?? "PROCESSED";
  const terminal = status !== "PENDING_REFERENCE";
  return sql`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
      wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
      reference_transaction_id, status, failure_code, result_balance, result_currency, next_attempt_at, pending_deadline_at, created_at, processed_at)
    values (${id}, ${r.providerId ?? "provider-a"}, ${ext}, ${r.key ?? `k-${id}`}, 'v1:sha256:x',
      ${r.walletId}, ${"p-" + r.walletId}, 'round-1', 'game-1', ${r.kind ?? "BET"}, ${r.amount ?? "10.00"}::numeric, 'BRL',
      ${r.refExternal ?? null}, ${r.refId ?? null}, ${status}, ${r.failureCode ?? null}, 100.00, 'BRL',
      ${terminal ? null : new Date()}, ${terminal ? null : new Date(Date.now() + 600_000)}, now(), ${terminal ? new Date() : null})`;
}

describe("migrations", () => {
  it("run up → down → up cleanly, and a second up is a no-op", async () => {
    const fresh = await createTestDb("migr", { migrate: false });
    try {
      const tables = async () =>
        (
          await fresh.owner`select table_name from information_schema.tables
                            where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1`
        ).map((r: { table_name: string }) => r.table_name);
      await migrateUp(fresh.ownerUrl);
      expect(await tables()).toEqual([
        "inbox_messages",
        "outbox_messages",
        "wager_transactions",
        "wallet_ledger_entries",
        "wallets",
      ]);
      await migrateDown(fresh.ownerUrl);
      expect(await tables()).toEqual([]);
      await migrateUp(fresh.ownerUrl);
      await migrateUp(fresh.ownerUrl);
      expect((await tables()).length).toBe(5);
    } finally {
      await fresh.drop();
    }
  });
});

describe("wallets", () => {
  it("balance can never be negative (CHECK)", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(db.app`update wallets set balance = -0.01 where id = ${walletId}`, "23514");
  });

  it("one wallet per player and currency (UNIQUE)", async () => {
    const { walletId } = await seedWallet(db.app, "0.00");
    await expectSqlState(
      db.app`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
             values (${crypto.randomUUID()}, ${"p-" + walletId}, 'BRL', 0, 1, now(), now())`,
      "23505",
    );
  });
});

describe("ledger is append-only", () => {
  it("the application role has no UPDATE, DELETE or TRUNCATE on it", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(db.app`update wallet_ledger_entries set amount = 1 where wallet_id = ${walletId}`, "42501");
    await expectSqlState(db.app`delete from wallet_ledger_entries where wallet_id = ${walletId}`, "42501");
    await expectSqlState(db.app`truncate wallet_ledger_entries`, "42501");
  });

  it("the application role cannot disable the triggers (only the owner can)", async () => {
    await expectSqlState(db.app`alter table wallet_ledger_entries disable trigger user`, "42501");
  });

  it("even the owner is stopped by the triggers (UPDATE, DELETE and TRUNCATE)", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(db.owner`update wallet_ledger_entries set amount = 1 where wallet_id = ${walletId}`, "P0001");
    await expectSqlState(db.owner`delete from wallet_ledger_entries where wallet_id = ${walletId}`, "P0001");
    await expectSqlState(db.owner`truncate wallet_ledger_entries cascade`, "P0001");
  });

  it("arithmetic must close (CHECK) and the currency must be the wallet's (FK)", async () => {
    const { walletId } = await seedWallet(db.app);
    const betId = crypto.randomUUID();
    await insertTx(db.app, { id: betId, walletId });
    await expectSqlState(
      db.app`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
               balance_before, balance_after, wallet_version, created_at)
             values (${crypto.randomUUID()}, ${walletId}, ${betId}, 'DEBIT', 10, 'BRL', 100, 95, 2, now())`,
      "23514",
    );
    await expectSqlState(
      db.app`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
               balance_before, balance_after, wallet_version, created_at)
             values (${crypto.randomUUID()}, ${walletId}, ${betId}, 'DEBIT', 10, 'USD', 100, 90, 2, now())`,
      "23503",
    );
  });

  it("one entry per transaction and per wallet version (UNIQUE)", async () => {
    const { walletId, openingId } = await seedWallet(db.app);
    await expectSqlState(
      db.app`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
               balance_before, balance_after, wallet_version, created_at)
             values (${crypto.randomUUID()}, ${walletId}, ${openingId}, 'DEBIT', 10, 'BRL', 100, 90, 2, now())`,
      "23505",
    );
    const betId = crypto.randomUUID();
    await insertTx(db.app, { id: betId, walletId });
    await expectSqlState(
      db.app`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
               balance_before, balance_after, wallet_version, created_at)
             values (${crypto.randomUUID()}, ${walletId}, ${betId}, 'DEBIT', 10, 'BRL', 100, 90, 1, now())`,
      "23505",
    );
  });
});

describe("wager_transactions", () => {
  it("cannot be deleted or truncated", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(db.app`delete from wager_transactions where wallet_id = ${walletId}`, "42501");
    await expectSqlState(db.owner`delete from wager_transactions where wallet_id = ${walletId}`, "P0001");
    await expectSqlState(db.owner`truncate wager_transactions cascade`, "P0001");
  });

  it("a terminal row never changes", async () => {
    const { walletId } = await seedWallet(db.app);
    const id = crypto.randomUUID();
    await insertTx(db.app, { id, walletId, status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
    await expectSqlState(
      db.app`update wager_transactions set status = 'PROCESSED', failure_code = null where id = ${id}`,
      "P0001",
    );
    await expectSqlState(db.app`update wager_transactions set attempts = 1 where id = ${id}`, "P0001");
  });

  it("business columns are immutable and only diagram transitions are accepted", async () => {
    const { walletId } = await seedWallet(db.app);
    const id = crypto.randomUUID();
    await insertTx(db.app, { id, walletId, kind: "REFUND", status: "PENDING_REFERENCE", refExternal: "bet-x" });
    await expectSqlState(db.app`update wager_transactions set amount = 99 where id = ${id}`, "P0001");
    await expectSqlState(db.app`update wager_transactions set kind = 'WIN' where id = ${id}`, "P0001");
    await expectSqlState(db.app`update wager_transactions set status = 'PENDING' where id = ${id}`, "P0001");
    // the retry loop is allowed
    await db.app`update wager_transactions set attempts = attempts + 1, next_attempt_at = now() where id = ${id}`;
  });

  it("idempotency key and external id are unique per provider", async () => {
    const { walletId } = await seedWallet(db.app);
    await insertTx(db.app, { walletId, key: "same-key", externalId: "e-1" });
    await expectSqlState(insertTx(db.app, { walletId, key: "same-key", externalId: "e-2" }), "23505");
    await expectSqlState(insertTx(db.app, { walletId, key: "other-key", externalId: "e-1" }), "23505");
    // other provider, same key: fine (a provider cannot poison another one's keys)
    await insertTx(db.app, { walletId, key: "same-key", externalId: "e-1", providerId: "provider-b" });
  });

  it("OPENING belongs to the internal provider only, and reversals need a reference", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(insertTx(db.app, { walletId, kind: "OPENING" }), "23514");
    await expectSqlState(insertTx(db.app, { walletId, kind: "REFUND", refExternal: null }), "23514");
  });

  it("a transaction is reversed at most once, by any kind (partial UNIQUE index)", async () => {
    const { walletId } = await seedWallet(db.app);
    const betId = crypto.randomUUID();
    await insertTx(db.app, { id: betId, walletId, externalId: "bet-1" });
    await insertTx(db.app, { walletId, kind: "REFUND", refExternal: "bet-1", refId: betId });
    await expectSqlState(insertTx(db.app, { walletId, kind: "ROLLBACK", refExternal: "bet-1", refId: betId }), "23505");
    // a REJECTED reversal does not count
    await insertTx(db.app, {
      walletId,
      kind: "ROLLBACK",
      refExternal: "bet-1",
      refId: betId,
      status: "REJECTED",
      failureCode: "ALREADY_REVERSED",
    });
  });

  it("status and failure code go together (CHECK)", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(insertTx(db.app, { walletId, status: "REJECTED", failureCode: null }), "23514");
    await expectSqlState(insertTx(db.app, { walletId, status: "PROCESSED", failureCode: "X" }), "23514");
  });
});

describe("deferred triggers tie every balance change to exactly one ledger entry", () => {
  it("a balance UPDATE without its entry fails at commit", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(
      db.app.begin(async (tx) => {
        await tx`update wallets set balance = 50, version = 2, updated_at = now() where id = ${walletId}`;
      }),
      "P0001",
    );
    const [w] = await db.app`select balance::text as b, version from wallets where id = ${walletId}`;
    expect(w).toEqual({ b: "100.00", version: 1 });
  });

  it("an entry without the wallet UPDATE fails at commit", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(
      db.app.begin(async (tx) => {
        const txId = crypto.randomUUID();
        await insertTx(tx as unknown as SQL, { id: txId, walletId });
        await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                   balance_before, balance_after, wallet_version, created_at)
                 values (${crypto.randomUUID()}, ${walletId}, ${txId}, 'DEBIT', 10, 'BRL', 100, 90, 2, now())`;
      }),
      "P0001",
    );
  });

  it("a REJECTED transaction can never have an entry", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(
      db.app.begin(async (tx) => {
        const txId = crypto.randomUUID();
        await insertTx(tx as unknown as SQL, { id: txId, walletId, status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
        await tx`update wallets set balance = 90, version = 2, updated_at = now() where id = ${walletId}`;
        await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                   balance_before, balance_after, wallet_version, created_at)
                 values (${crypto.randomUUID()}, ${walletId}, ${txId}, 'DEBIT', 10, 'BRL', 100, 90, 2, now())`;
      }),
      "P0001",
    );
  });

  it("an entry whose balance_before does not match the old balance fails at commit", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(
      db.app.begin(async (tx) => {
        const txId = crypto.randomUUID();
        await insertTx(tx as unknown as SQL, { id: txId, walletId });
        await tx`update wallets set balance = 80, version = 2, updated_at = now() where id = ${walletId}`;
        await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                   balance_before, balance_after, wallet_version, created_at)
                 values (${crypto.randomUUID()}, ${walletId}, ${txId}, 'DEBIT', 10, 'BRL', 90, 80, 2, now())`;
      }),
      "P0001",
    );
  });

  it("a consistent debit commits", async () => {
    const { walletId } = await seedWallet(db.app);
    await db.app.begin(async (tx) => {
      const txId = crypto.randomUUID();
      await insertTx(tx as unknown as SQL, { id: txId, walletId });
      await tx`update wallets set balance = 90, version = 2, updated_at = now() where id = ${walletId}`;
      await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                 balance_before, balance_after, wallet_version, created_at)
               values (${crypto.randomUUID()}, ${walletId}, ${txId}, 'DEBIT', 10, 'BRL', 100, 90, 2, now())`;
    });
    const [w] = await db.app`select balance::text as b, version from wallets where id = ${walletId}`;
    expect(w).toEqual({ b: "90.00", version: 2 });
  });

  it("a wallet born with balance needs its opening entry", async () => {
    await expectSqlState(
      db.app`insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
             values (${crypto.randomUUID()}, ${"p-" + crypto.randomUUID()}, 'BRL', 10, 1, now(), now())`,
      "P0001",
    );
  });

  // La-03: the entry used to be checked only against the transaction status, not its value or direction
  it("a phantom entry backed by a zero-value transaction fails at commit (wallet opened with 0.00)", async () => {
    const { walletId } = await seedWallet(db.app, "0.00");
    const zeroWin = crypto.randomUUID();
    await insertTx(db.app, { id: zeroWin, walletId, kind: "WIN", amount: "0.00" });
    await expectSqlState(
      db.app`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
               balance_before, balance_after, wallet_version, created_at)
             values (${crypto.randomUUID()}, ${walletId}, ${zeroWin}, 'CREDIT', 500, 'BRL', 0, 500, 1, now())`,
      "P0001",
    );
    const [n] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId}`;
    expect(n.n).toBe(0);
  });

  it("an entry whose amount differs from its transaction fails at commit", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(
      db.app.begin(async (tx) => {
        const txId = crypto.randomUUID();
        await insertTx(tx as unknown as SQL, { id: txId, walletId, amount: "10.00" });
        await tx`update wallets set balance = 95, version = 2, updated_at = now() where id = ${walletId}`;
        await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                   balance_before, balance_after, wallet_version, created_at)
                 values (${crypto.randomUUID()}, ${walletId}, ${txId}, 'DEBIT', 5, 'BRL', 100, 95, 2, now())`;
      }),
      "P0001",
    );
  });

  it("an entry in the wrong direction for its kind fails at commit (a BET that credits)", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(
      db.app.begin(async (tx) => {
        const txId = crypto.randomUUID();
        await insertTx(tx as unknown as SQL, { id: txId, walletId, kind: "BET", amount: "10.00" });
        await tx`update wallets set balance = 110, version = 2, updated_at = now() where id = ${walletId}`;
        await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                   balance_before, balance_after, wallet_version, created_at)
                 values (${crypto.randomUUID()}, ${walletId}, ${txId}, 'CREDIT', 10, 'BRL', 100, 110, 2, now())`;
      }),
      "P0001",
    );
  });

  it("a reversal entry must go against the entry it reverses (a REFUND of a BET that debits fails)", async () => {
    const { walletId } = await seedWallet(db.app);
    const betId = crypto.randomUUID();
    await db.app.begin(async (tx) => {
      await insertTx(tx as unknown as SQL, { id: betId, walletId, kind: "BET", amount: "10.00", externalId: `bet-${betId}` });
      await tx`update wallets set balance = 90, version = 2, updated_at = now() where id = ${walletId}`;
      await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                 balance_before, balance_after, wallet_version, created_at)
               values (${crypto.randomUUID()}, ${walletId}, ${betId}, 'DEBIT', 10, 'BRL', 100, 90, 2, now())`;
    });
    await expectSqlState(
      db.app.begin(async (tx) => {
        const refundId = crypto.randomUUID();
        await insertTx(tx as unknown as SQL, {
          id: refundId,
          walletId,
          kind: "REFUND",
          amount: "10.00",
          refExternal: `bet-${betId}`,
          refId: betId,
        });
        await tx`update wallets set balance = 80, version = 3, updated_at = now() where id = ${walletId}`;
        await tx`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                   balance_before, balance_after, wallet_version, created_at)
                 values (${crypto.randomUUID()}, ${walletId}, ${refundId}, 'DEBIT', 10, 'BRL', 90, 80, 3, now())`;
      }),
      "P0001",
    );
  });
});

describe("NaN never enters a money column (C4: Postgres orders NaN above every number)", () => {
  it("a transaction amount of NaN is refused by a CHECK", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(insertTx(db.app, { walletId, amount: "NaN" }), "23514");
  });

  it("a wallet balance of NaN is refused by a CHECK, before the deferred trigger", async () => {
    const { walletId } = await seedWallet(db.app);
    await expectSqlState(db.app`update wallets set balance = 'NaN', version = 2, updated_at = now() where id = ${walletId}`, "23514");
  });

  it("a ledger amount of NaN is refused by a CHECK", async () => {
    const { walletId, openingId } = await seedWallet(db.app);
    await expectSqlState(
      db.app`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
               balance_before, balance_after, wallet_version, created_at)
             values (${crypto.randomUUID()}, ${walletId}, ${openingId}, 'CREDIT', 'NaN', 'BRL', 100, 'NaN', 2, now())`,
      "23514",
    );
  });
});

describe("inbox", () => {
  it("(consumer_name, message_id) is the primary key", async () => {
    await db.app`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
                 values ('c', 'm-1', 'h', now(), now())`;
    await expectSqlState(
      db.app`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
             values ('c', 'm-1', 'h', now(), now())`,
      "23505",
    );
  });
});
