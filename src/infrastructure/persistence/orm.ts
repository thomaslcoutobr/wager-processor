import { Migrator } from "@mikro-orm/migrations";
import { MikroORM, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Migration20261107000100_schema } from "./migrations/Migration20261107000100_schema";
import { ALL_SCHEMAS } from "./schemas";

/** Explicit list instead of a glob: works the same from source, in the container and in tests. */
export const MIGRATIONS = [{ name: "Migration20261107000100_schema", class: Migration20261107000100_schema }];

export interface OrmOptions {
  url: string;
  poolMax?: number;
  withMigrator?: boolean;
}

export async function createOrm(opts: OrmOptions): Promise<MikroORM> {
  return MikroORM.init({
    driver: PostgreSqlDriver,
    clientUrl: opts.url,
    entities: ALL_SCHEMAS,
    extensions: opts.withMigrator ? [Migrator] : [],
    pool: { min: 0, max: opts.poolMax ?? 10 },
    debug: false,
    colors: false,
    allowGlobalContext: false,
    migrations: { migrationsList: MIGRATIONS, snapshot: false, transactional: true, silent: true },
  });
}
