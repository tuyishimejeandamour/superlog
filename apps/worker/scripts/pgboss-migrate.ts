// One-shot: install/migrate the pg-boss schema, then exit. Meant to run in the
// SAME gated step as Drizzle migrations, as the schema-owner role — NOT on app
// boot (the runtime worker connects with migrate:false). pg-boss owns its own
// schema DDL across versions, so this is how its migrations ride the normal
// gated-migration path instead of being hand-authored.
//
// Reads PG* (libpq) env like the Drizzle migrate task, falling back to
// DATABASE_URL for local/worktree use. supervise/schedule are disabled so this
// only installs/migrates and does no maintenance or cron work before exiting.

import { PgBoss } from "pg-boss";

function dbConfig(): Record<string, unknown> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) return { connectionString };
  return {
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
  };
}

const schema = process.env.PGBOSS_SCHEMA || "pgboss";
const boss = new PgBoss({
  ...dbConfig(),
  schema,
  migrate: true,
  supervise: false,
  schedule: false,
});

try {
  await boss.start();
  console.log(JSON.stringify({ scope: "pgboss.migrate", schema, status: "ok" }));
} catch (err) {
  console.error(
    JSON.stringify({
      scope: "pgboss.migrate",
      schema,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: false }).catch(() => {});
}
