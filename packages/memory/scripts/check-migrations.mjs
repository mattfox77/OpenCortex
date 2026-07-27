#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(packageRoot, "migrations");
const migrationPattern = /^(\d{3})_[a-z0-9_]+\.sql$/;

const files = (await readdir(migrationsDir))
  .filter((file) => file.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  throw new Error("No memory migrations found");
}

for (const [index, file] of files.entries()) {
  const match = migrationPattern.exec(file);
  if (!match) {
    throw new Error(`Migration name must match NNN_description.sql: ${file}`);
  }
  const expected = String(index + 1).padStart(3, "0");
  if (match[1] !== expected) {
    throw new Error(`Migration sequence gap: expected ${expected}, found ${file}`);
  }
}

const firstMigration = await readFile(join(migrationsDir, files[0]), "utf8");
for (const required of [
  "CREATE EXTENSION IF NOT EXISTS vector",
  "CREATE TABLE IF NOT EXISTS entries",
  "embedding     vector(768)",
  "q_embedding   vector(768)",
]) {
  if (!firstMigration.includes(required)) {
    throw new Error(`Initial migration is missing required statement: ${required}`);
  }
}

if (!process.env.OPENCORTEX_MEMORY_TEST_DATABASE_URL) {
  console.warn("Skipping executable migration check; set OPENCORTEX_MEMORY_TEST_DATABASE_URL to validate against an empty pgvector database.");
  process.exit(0);
}

const result = spawnSync(process.execPath, [join(packageRoot, "scripts", "migrate.mjs")], {
  cwd: packageRoot,
  env: {
    ...process.env,
    DATABASE_URL: process.env.OPENCORTEX_MEMORY_TEST_DATABASE_URL,
  },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
