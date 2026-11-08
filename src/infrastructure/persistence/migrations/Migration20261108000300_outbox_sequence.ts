import { Migration } from "@mikro-orm/migrations";

/**
 * Outbox order by a database sequence (ARCHITECTURE §13), as a migration of its own:
 *  - R2b-02  the order inside a group (a wallet) was (occurred_at, id), and occurred_at comes from the
 *           clock of the instance that decided. Two instances with clocks a few ms apart could publish
 *           version 3 before version 2. `seq` is taken by the INSERT, inside the business transaction,
 *           after the wallet lock: for one wallet it follows the lock order, whatever the clocks say.
 *  - R2b-H1  the head lookup and the group read are by (message_group_id, seq) over unpublished rows,
 *           so a partial index on exactly that keeps them off a scan of the whole backlog.
 *  - R3-01   the rows already in the table are numbered by the OLD rule, (occurred_at, id), before the
 *           sequence takes over. `ADD COLUMN ... bigserial` would number them in physical order, and a
 *           head the publisher had retried (an UPDATE moves the row) would land after its followers.
 */
export class Migration20261108000300_outbox_sequence extends Migration {
  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE outbox_messages ADD COLUMN seq bigint;`);
    this.addSql(`
      UPDATE outbox_messages o SET seq = r.n
        FROM (SELECT id, row_number() OVER (ORDER BY occurred_at, id) AS n FROM outbox_messages) r
       WHERE r.id = o.id;`);
    this.addSql(`CREATE SEQUENCE outbox_messages_seq_seq OWNED BY outbox_messages.seq;`);
    this.addSql(`SELECT setval('outbox_messages_seq_seq', coalesce((SELECT max(seq) FROM outbox_messages), 0) + 1, false);`);
    this.addSql(`ALTER TABLE outbox_messages ALTER COLUMN seq SET DEFAULT nextval('outbox_messages_seq_seq'),
                                             ALTER COLUMN seq SET NOT NULL;`);
    this.addSql(`CREATE INDEX ix_outbox_group_pending ON outbox_messages (message_group_id, seq) WHERE published_at IS NULL;`);
    // the app role inserts rows, so it draws from the sequence
    this.addSql(`GRANT USAGE ON SEQUENCE outbox_messages_seq_seq TO wager_app;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS ix_outbox_group_pending;`);
    // the sequence is owned by the column and goes with it
    this.addSql(`ALTER TABLE outbox_messages DROP COLUMN IF EXISTS seq;`);
  }
}
