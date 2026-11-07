import { createOrm } from "./orm";

/** Runs pending migrations as the table owner. Concurrent runners are serialized by an advisory lock. */
export async function migrateUp(ownerUrl: string): Promise<string[]> {
  const orm = await createOrm({ url: ownerUrl, poolMax: 2, withMigrator: true });
  try {
    return await orm.em.fork().transactional(async (em) => {
      // held until this outer transaction ends, i.e. after the migrator (own connection) finished
      await em.execute("select pg_advisory_xact_lock(7311001)");
      const done = await orm.migrator.up();
      return done.map((m) => m.name);
    });
  } finally {
    await orm.close(true);
  }
}

export async function migrateDown(ownerUrl: string): Promise<void> {
  const orm = await createOrm({ url: ownerUrl, poolMax: 2, withMigrator: true });
  try {
    await orm.migrator.down({ to: 0 });
  } finally {
    await orm.close(true);
  }
}
