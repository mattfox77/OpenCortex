#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

function runPsql(sql, label) {
  const result = spawnSync("psql", [databaseUrl, "--set", "ON_ERROR_STOP=1", "--quiet"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error?.code === "ENOENT") {
    console.error("psql is required to run memory migrations");
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Migration command failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

const migrationsDir = join(packageRoot, "migrations");
const files = (await readdir(migrationsDir))
  .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
  .sort();

runPsql(
  `
  CREATE TABLE IF NOT EXISTS _opencortex_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
  `,
  "create migration ledger",
);

for (const file of files) {
  const migration = await readFile(join(migrationsDir, file), "utf8");
  const sql = `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM _opencortex_migrations WHERE name = ${quoteLiteral(file)}) THEN
        RAISE NOTICE 'Skipping migration %', ${quoteLiteral(file)};
      ELSE
        RAISE NOTICE 'Applying migration %', ${quoteLiteral(file)};
      END IF;
    END $$;
  `;
  runPsql(sql, file);

  const appliedCheck = spawnSync(
    "psql",
    [databaseUrl, "--tuples-only", "--no-align", "--quiet", "--command", `SELECT 1 FROM _opencortex_migrations WHERE name = ${quoteLiteral(file)};`],
    { encoding: "utf8" },
  );
  if (appliedCheck.stdout.trim() === "1") {
    continue;
  }

  runPsql(`BEGIN;\n${migration}\nINSERT INTO _opencortex_migrations (name) VALUES (${quoteLiteral(file)});\nCOMMIT;`, file);
}

console.log(`Applied ${files.length} memory migrations`);

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
