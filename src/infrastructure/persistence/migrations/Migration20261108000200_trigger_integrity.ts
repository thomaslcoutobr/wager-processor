import { Migration } from "@mikro-orm/migrations";

/**
 * Second round of the F4 review (ARCHITECTURE §6.5), as a migration of its own:
 *  - R2a-01 / R2c-01  an OPENING entry is accepted only on the wallet as it was opened (version 1,
 *           balance = balance_after). Before, a 0.00 wallet left version 1 free for a late OPENING
 *           with no wallet UPDATE, and the stored balance and the ledger drifted apart.
 *  - R2c-02  every trigger function runs with search_path = public, pg_temp, and PUBLIC loses
 *           TEMPORARY on the database. Before, a session could shadow wallet_ledger_entries or
 *           wager_transactions with a temporary table (pg_temp is searched first when not listed) and
 *           the deferred checks read the shadow.
 *  - R2c-03  result_currency must be the wallet currency (composite FK; NULL is not checked).
 */
const TRIGGER_FUNCTIONS = ["forbid_mutation()", "wtx_guard()", "ledger_entry_is_backed()", "wallet_change_is_backed()", "wallet_guard()"];

const LEDGER_ENTRY_IS_BACKED = (openingRule: boolean) => `
      CREATE OR REPLACE FUNCTION ledger_entry_is_backed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        t         record;
        expected  text;
        w_version integer;
        w_balance numeric;
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
        SELECT version, balance INTO w_version, w_balance FROM wallets WHERE id = NEW.wallet_id;
        IF w_version IS NULL OR NEW.wallet_version > w_version THEN
          RAISE EXCEPTION 'ledger entry % claims wallet version % but the wallet is at %', NEW.id, NEW.wallet_version, w_version;
        END IF;${
          openingRule
            ? `
        -- the OPENING is born with the wallet: still at version 1 and holding exactly what it credits
        IF t.kind = 'OPENING' AND (w_version <> 1 OR w_balance IS DISTINCT FROM NEW.balance_after) THEN
          RAISE EXCEPTION 'ledger entry %: an OPENING entry must be written with the wallet it opens (wallet at version %, balance %)',
            NEW.id, w_version, w_balance;
        END IF;`
            : ""
        }
        RETURN NULL;
      END $$;`;

export class Migration20261108000200_trigger_integrity extends Migration {
  override async up(): Promise<void> {
    this.addSql(LEDGER_ENTRY_IS_BACKED(true));
    for (const fn of TRIGGER_FUNCTIONS) this.addSql(`ALTER FUNCTION ${fn} SET search_path = public, pg_temp;`);
    this.addSql(`DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()); END $$;`);
    this.addSql(`ALTER TABLE wager_transactions ADD CONSTRAINT fk_wtx_result_currency
                   FOREIGN KEY (wallet_id, result_currency) REFERENCES wallets (id, currency);`);
  }

  override async down(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT IF EXISTS fk_wtx_result_currency;`);
    this.addSql(`DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database()); END $$;`);
    for (const fn of TRIGGER_FUNCTIONS) this.addSql(`ALTER FUNCTION ${fn} RESET search_path;`);
    // back to the rules of Migration20261108000100_review_hardening (no OPENING rule)
    this.addSql(LEDGER_ENTRY_IS_BACKED(false));
  }
}
