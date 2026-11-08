import { Migration } from "@mikro-orm/migrations";

/**
 * Whole schema in hand-written SQL (ARCHITECTURE §6). Diff-based generation is not used because the
 * guarantees live in CHECKs, triggers and partial indexes the metadata diff does not understand.
 */
export class Migration20261107000100_schema extends Migration {
  override async up(): Promise<void> {
    // §6.1 roles: the app connects as wager_app, which owns nothing. Roles are cluster objects, so
    // creation tolerates parallel test databases racing to create it.
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wager_app') THEN
          BEGIN
            CREATE ROLE wager_app LOGIN PASSWORD 'wager_app';
          EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
          END;
        END IF;
      END $$;`);

    // §6.2
    this.addSql(`
      CREATE TABLE wallets (
        id         uuid          PRIMARY KEY,
        player_id  text          NOT NULL CHECK (char_length(player_id) BETWEEN 1 AND 64),
        currency   char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance    numeric(20,2) NOT NULL CHECK (balance >= 0 AND balance <> 'NaN'),
        version    integer       NOT NULL CHECK (version >= 1),
        created_at timestamptz   NOT NULL,
        updated_at timestamptz   NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT uq_wallets_id_currency     UNIQUE (id, currency)
      );`);

    // §6.3
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       text          NOT NULL CHECK (provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' OR provider_id = '__internal__'),
        external_transaction_id           text          NOT NULL CHECK (char_length(external_transaction_id) BETWEEN 1 AND 128),
        idempotency_key                   text          NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
        payload_hash                      text          NOT NULL,
        wallet_id                         uuid          NOT NULL REFERENCES wallets (id),
        player_id                         text          NOT NULL,
        round_id                          text,
        game_id                           text,
        kind                              text          NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            numeric(20,2) NOT NULL CHECK (amount >= 0 AND amount <> 'NaN'),
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid          REFERENCES wager_transactions (id),
        status                            text          NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      text,
        result_balance                    numeric(20,2) CHECK (result_balance >= 0 AND result_balance <> 'NaN'),
        result_currency                   char(3),
        attempts                          integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at                   timestamptz,
        pending_deadline_at               timestamptz,
        created_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz,

        CONSTRAINT uq_wtx_provider_idempotency_key UNIQUE (provider_id, idempotency_key),
        CONSTRAINT uq_wtx_provider_external_id     UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wtx_id_wallet                UNIQUE (id, wallet_id),
        CONSTRAINT ck_wtx_opening_is_internal  CHECK ((kind = 'OPENING') = (provider_id = '__internal__')),
        CONSTRAINT ck_wtx_round_and_game       CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
        CONSTRAINT ck_wtx_reversal_has_ref     CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wtx_failure_code         CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_wtx_terminal_has_time    CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),
        CONSTRAINT ck_wtx_result_balance       CHECK (status NOT IN ('PROCESSED','REJECTED','PENDING_REFERENCE') OR result_balance IS NOT NULL),
        CONSTRAINT ck_wtx_result_currency      CHECK ((result_balance IS NULL) = (result_currency IS NULL)),
        CONSTRAINT ck_wtx_pending_schedule     CHECK (status <> 'PENDING_REFERENCE' OR (next_attempt_at IS NOT NULL AND pending_deadline_at IS NOT NULL)),
        CONSTRAINT ck_wtx_processed_ref_known  CHECK (NOT (status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')) OR reference_transaction_id IS NOT NULL)
      );`);
    this.addSql(`CREATE UNIQUE INDEX uq_wtx_reversed_once ON wager_transactions (reference_transaction_id)
                   WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';`);
    this.addSql(`CREATE INDEX ix_wtx_pending_due ON wager_transactions (next_attempt_at)
                   WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`CREATE INDEX ix_wtx_pending_by_ref ON wager_transactions (provider_id, reference_external_transaction_id)
                   WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`CREATE INDEX ix_wtx_wallet ON wager_transactions (wallet_id);`);

    // §6.4
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid          PRIMARY KEY,
        wallet_id      uuid          NOT NULL,
        transaction_id uuid          NOT NULL,
        direction      text          NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount         numeric(20,2) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'),
        currency       char(3)       NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0 AND balance_before <> 'NaN'),
        balance_after  numeric(20,2) NOT NULL CHECK (balance_after  >= 0 AND balance_after  <> 'NaN'),
        wallet_version integer       NOT NULL CHECK (wallet_version >= 1),
        created_at     timestamptz   NOT NULL,

        CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT uq_ledger_wallet_version     UNIQUE (wallet_id, wallet_version),
        CONSTRAINT fk_ledger_wallet_currency    FOREIGN KEY (wallet_id, currency)       REFERENCES wallets (id, currency),
        CONSTRAINT fk_ledger_transaction        FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END)
      );`);

    // §6.6
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  text        NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );`);
    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid        PRIMARY KEY,
        aggregate_id     text        NOT NULL,
        message_group_id text        NOT NULL,
        event_type       text        NOT NULL,
        event_version    integer     NOT NULL,
        payload          jsonb       NOT NULL,
        occurred_at      timestamptz NOT NULL,
        attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz NOT NULL,
        published_at     timestamptz,
        last_error       text
      );`);
    this.addSql(`CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at, id) WHERE published_at IS NULL;`);

    // ---- append-only guards (row triggers do not fire on TRUNCATE, hence the statement triggers)
    this.addSql(`
      CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only: % blocked', TG_TABLE_NAME, TG_OP;
      END $$;`);
    this.addSql(`CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON wallet_ledger_entries
                   FOR EACH ROW EXECUTE FUNCTION forbid_mutation();`);
    this.addSql(`CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
                   FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();`);
    this.addSql(`CREATE TRIGGER wtx_no_delete BEFORE DELETE ON wager_transactions
                   FOR EACH ROW EXECUTE FUNCTION forbid_mutation();`);
    this.addSql(`CREATE TRIGGER wtx_no_truncate BEFORE TRUNCATE ON wager_transactions
                   FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();`);

    // ---- §6.3 wtx_guard: terminal rows are frozen, business columns are immutable, only diagram transitions
    this.addSql(`
      CREATE FUNCTION wtx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%) and cannot change', OLD.id, OLD.status;
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
           OR NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id
           OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
           OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
           OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
           OR NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.round_id IS DISTINCT FROM OLD.round_id
           OR NEW.game_id IS DISTINCT FROM OLD.game_id
           OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.amount IS DISTINCT FROM OLD.amount
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'wager transaction %: identity and business columns are immutable', OLD.id;
        END IF;
        IF NOT (
             (OLD.status = 'PENDING' AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))
          OR (OLD.status = 'PENDING_REFERENCE' AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))
        ) THEN
          RAISE EXCEPTION 'wager transaction %: transition % -> % is not allowed', OLD.id, OLD.status, NEW.status;
        END IF;
        RETURN NEW;
      END $$;`);
    this.addSql(`CREATE TRIGGER wtx_guard BEFORE UPDATE ON wager_transactions
                   FOR EACH ROW EXECUTE FUNCTION wtx_guard();`);

    // ---- §6.2 wallet_guard: identity, owner, currency and creation time never change (balance/version do,
    // under wallet_change_is_backed)
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
    this.addSql(`CREATE TRIGGER wallet_guard BEFORE UPDATE ON wallets
                   FOR EACH ROW EXECUTE FUNCTION wallet_guard();`);

    // ---- §6.4 every ledger entry is backed by a PROCESSED, balance-affecting transaction of the same value,
    // moving money the way its kind does (a reversal goes against the entry it reverses); checked at COMMIT
    this.addSql(`
      CREATE FUNCTION ledger_entry_is_backed() RETURNS trigger LANGUAGE plpgsql AS $$
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
    this.addSql(`CREATE CONSTRAINT TRIGGER ledger_entry_is_backed AFTER INSERT ON wallet_ledger_entries
                   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_is_backed();`);

    // ---- §6.5 every balance/version change of a wallet has exactly the matching entry (checked at COMMIT)
    this.addSql(`
      CREATE FUNCTION wallet_change_is_backed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.version <> 1 THEN
            RAISE EXCEPTION 'wallet % must be created at version 1', NEW.id;
          END IF;
          IF NEW.balance > 0 AND NOT EXISTS (
               SELECT 1 FROM wallet_ledger_entries
                WHERE wallet_id = NEW.id AND wallet_version = 1 AND direction = 'CREDIT'
                  AND balance_before = 0 AND balance_after = NEW.balance) THEN
            RAISE EXCEPTION 'wallet % was created with balance % but has no opening entry', NEW.id, NEW.balance;
          END IF;
          RETURN NULL;
        END IF;
        IF NEW.balance IS DISTINCT FROM OLD.balance OR NEW.version IS DISTINCT FROM OLD.version THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'wallet %: version must move by exactly one (% -> %)', NEW.id, OLD.version, NEW.version;
          END IF;
          IF NOT EXISTS (
               SELECT 1 FROM wallet_ledger_entries
                WHERE wallet_id = NEW.id AND wallet_version = NEW.version
                  AND balance_before = OLD.balance AND balance_after = NEW.balance) THEN
            RAISE EXCEPTION 'wallet %: balance % -> % (version %) has no matching ledger entry',
              NEW.id, OLD.balance, NEW.balance, NEW.version;
          END IF;
        END IF;
        RETURN NULL;
      END $$;`);
    this.addSql(`CREATE CONSTRAINT TRIGGER wallet_change_is_backed AFTER INSERT OR UPDATE ON wallets
                   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_change_is_backed();`);

    // ---- privileges: no DELETE/TRUNCATE anywhere, and only SELECT/INSERT on the ledger
    this.addSql(`GRANT USAGE ON SCHEMA public TO wager_app;`);
    this.addSql(`GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, inbox_messages, outbox_messages TO wager_app;`);
    this.addSql(`GRANT SELECT, INSERT ON wallet_ledger_entries TO wager_app;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_change_is_backed();`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_entry_is_backed();`);
    this.addSql(`DROP FUNCTION IF EXISTS wtx_guard();`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_guard();`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_mutation();`);
    // the role is a cluster object that may hold privileges in other databases: revoke, never drop
    this.addSql(`REVOKE USAGE ON SCHEMA public FROM wager_app;`);
  }
}
