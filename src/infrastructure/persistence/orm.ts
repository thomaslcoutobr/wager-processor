import { Migrator } from "@mikro-orm/migrations";
import { MikroORM, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Migration20261107000100_schema } from "./migrations/Migration20261107000100_schema";
import { ALL_SCHEMAS } from "./schemas";

/** Explicit list instead of a glob: works the same from source, in the container and in tests. */
export const MIGRATIONS = [{ name: "Migration20261107000100_schema", class: Migration20261107000100_schema }];

export interface OrmOptions {
  url: string;
  poolMax?: number;
  /** Waiting for a free connection, or opening one, gives up after this (pg-pool connectionTimeoutMillis). */
  connectTimeoutMs?: number;
  /** Client-side read timeout of each query: a database that hangs without closing the socket still fails. */
  queryTimeoutMs?: number;
  withMigrator?: boolean;
}

export async function createOrm(opts: OrmOptions): Promise<MikroORM> {
  return MikroORM.init({
    driver: PostgreSqlDriver,
    clientUrl: opts.url,
    entities: ALL_SCHEMAS,
    extensions: opts.withMigrator ? [Migrator] : [],
    pool: { min: 0, max: opts.poolMax ?? 10 },
    // without these, pg waits forever for a connection or a reply (both default to no limit);
    // keepAlive lets the OS notice a peer that vanished without closing the socket
    driverOptions: {
      ...(opts.connectTimeoutMs ? { connectionTimeoutMillis: opts.connectTimeoutMs } : {}),
      ...(opts.queryTimeoutMs ? { query_timeout: opts.queryTimeoutMs } : {}),
      keepAlive: true,
    },
    debug: false,
    colors: false,
    allowGlobalContext: false,
    migrations: { migrationsList: MIGRATIONS, snapshot: false, transactional: true, silent: true },
  });
}
