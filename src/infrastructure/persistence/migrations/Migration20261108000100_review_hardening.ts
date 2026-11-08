import { Migration } from "@mikro-orm/migrations";

/**
 * Hardening from the F4 review (ARCHITECTURE §6), as a migration of its own so a database already at
 * the first one moves forward without being recreated:
 *  - La-01  result_currency: the replayed balance keeps the wallet currency (backfilled from wallets);
 *  - C4     money columns refuse 'NaN' (Postgres orders NaN above every number, so ">= 0" let it in);
 *  - La-03 / Lc-01  every ledger entry matches its transaction in amount, currency and direction, and
 *           version 1 belongs to the OPENING only;
 *  - Lc-02  wallet_guard: id, player_id, currency and created_at of a wallet never change.
 */
export class Migration20261108000100_review_hardening extends Migration {
  override async up(): Promise<void> {
    // La-01. Terminal rows are frozen by wtx_guard, so the backfill runs with it off, inside this
    // migration's transaction (the owner can do it; the app role cannot, §6.1).
    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN result_currency char(3);`);
    this.addSql(`ALTER TABLE wager_transactions DISABLE TRIGGER wtx_guard;`);
    this.addSql(`UPDATE wager_transactions t SET result_currency = w.currency
                   FROM wallets w WHERE w.id = t.wallet_id AND t.result_balance IS NOT NULL;`);
    this.addSql(`ALTER TABLE wager_transactions ENABLE TRIGGER wtx_guard;`);
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT ck_wtx_result_currency
                   CHECK ((result_balance IS NULL) = (result_currency IS NULL));`);

    // C4
    this.addSql(`ALTER TABLE wallets ADD CONSTRAINT ck_wallets_balance_not_nan CHECK (balance <> 'NaN');`);
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT ck_wtx_amount_not_nan CHECK (amount <> 'NaN');`);
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT ck_wtx_result_balance_valid
                   CHECK (result_balance >= 0 AND result_balance <> 'NaN');`);
    this.addSql(`ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ck_ledger_money_not_nan
                   CHECK (amount <> 'NaN' AND balance_before <> 'NaN' AND balance_after <> 'NaN');`);

    // La-03 + Lc-01: same trigger, stricter body
    this.addSql(`
      CREATE OR REPLACE FUNCTION ledger_entry_is_backed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        t         record;
        expected  text;
        w_version integer;
      BEGIN
        SELECT status, kind, amount, currency, reference_transaction_id INTO t
          FROM wager_transactions WHERE id = NEW.transaction_id;
        IF t.status IS DISTINCT FROM 'PROCESSED' OR t.kind = 'LOSS' THEN
          RAISE EXCEPTION 'ledger entry % is not backed by a processed balance-affecting transaction (status %, kind %)',
            NEW.id, t.status, t.kind;
        END IF;
        IF NEW.amount IS DISTINCT FROM t.amount OR NEW.currency IS DISTINCT FROM t.currency THEN
          RAISE EXCEPTION 'ledger entry % moves % % but its transaction is % %', NEW.id, NEW.amount, NEW.currency, t.amount, t.currency;
        END IF;
        IF t.kind = 'BET' THEN
          expected := 'DEBIT';
        ELSIF t.kind IN ('WIN','OPENING') THEN
          expected := 'CREDIT';
        ELSE
          SELECT CASE direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END INTO expected
            FROM wallet_ledger_entries WHERE transaction_id = t.reference_transaction_id;
        END IF;
        IF expected IS NULL OR NEW.direction <> expected THEN
          RAISE EXCEPTION 'ledger entry % is a % but this % must be a %', NEW.id, NEW.direction, t.kind, coalesce(expected, '(nothing to reverse)');
        END IF;
        -- version 1 is the wallet as it was opened: only the OPENING entry lives there (a 0.00 wallet has none)
        IF (NEW.wallet_version = 1) <> (t.kind = 'OPENING') THEN
          RAISE EXCEPTION 'ledger entry %: version 1 is reserved for the OPENING entry (kind %, version %)', NEW.id, t.kind, NEW.wallet_version;
        END IF;
        SELECT version INTO w_version FROM wallets WHERE id = NEW.wallet_id;
        IF w_version IS NULL OR NEW.wallet_version > w_version THEN
          RAISE EXCEPTION 'ledger entry % claims wallet version % but the wallet is at %', NEW.id, NEW.wallet_version, w_version;
        END IF;
        RETURN NULL;
      END $$;`);

    // Lc-02
    this.addSql(`
      CREATE FUNCTION wallet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'wallet %: id, player_id, currency and created_at are immutable', OLD.id;
        END IF;
        RETURN NEW;
      END $$;`);
    this.addSql(`CREATE TRIGGER wallet_guard BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION wallet_guard();`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS wallet_guard ON wallets;`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_guard();`);
    // the body of the first migration
    this.addSql(`
      CREATE OR REPLACE FUNCTION ledger_entry_is_backed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        t_status text;
        t_kind   text;
        w_version integer;
      BEGIN
        SELECT status, kind INTO t_status, t_kind FROM wager_transactions WHERE id = NEW.transaction_id;
        IF t_status IS DISTINCT FROM 'PROCESSED' OR t_kind = 'LOSS' THEN
          RAISE EXCEPTION 'ledger entry % is not backed by a processed balance-affecting transaction (status %, kind %)',
            NEW.id, t_status, t_kind;
        END IF;
        SELECT version INTO w_version FROM wallets WHERE id = NEW.wallet_id;
        IF w_version IS NULL OR NEW.wallet_version > w_version THEN
          RAISE EXCEPTION 'ledger entry % claims wallet version % but the wallet is at %', NEW.id, NEW.wallet_version, w_version;
        END IF;
        RETURN NULL;
      END $$;`);
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS ck_ledger_money_not_nan;`);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS ck_wtx_result_balance_valid;`);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS ck_wtx_amount_not_nan;`);
    this.addSql(`ALTER TABLE wallets DROP CONSTRAINT IF EXISTS ck_wallets_balance_not_nan;`);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS ck_wtx_result_currency;`);
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN IF EXISTS result_currency;`);
  }
}
