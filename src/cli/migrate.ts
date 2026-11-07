import { migrateUp } from "../infrastructure/persistence/migrate";

/** One-shot: `bun src/cli/migrate.ts` (the `migrate` service of the compose runs it before the app). */
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error("DATABASE_MIGRATION_URL is required (owner role)");
  process.exit(1);
}
const applied = await migrateUp(url);
console.log(JSON.stringify({ level: "info", msg: "migrations applied", applied }));
process.exit(0);
