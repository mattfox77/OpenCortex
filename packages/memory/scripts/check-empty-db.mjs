#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtime = process.env.CONTAINER_RUNTIME || findContainerRuntime();
const image = process.env.OPENCORTEX_MEMORY_TEST_IMAGE || "docker.io/pgvector/pgvector:pg16";
const container = `opencortex-memory-empty-db-${process.pid}`;

if (!runtime) {
  console.error("podman or docker is required for the empty memory database check");
  process.exit(1);
}

try {
  run(runtime, ["rm", "-f", container], { allowFailure: true });
  run(runtime, [
    "run",
    "-d",
    "--name",
    container,
    "-e",
    "POSTGRES_USER=opencortex",
    "-e",
    "POSTGRES_PASSWORD=opencortex",
    "-e",
    "POSTGRES_DB=opencortex",
    image,
  ]);

  waitForPostgres();
  run(runtime, ["cp", join(packageRoot, "migrations"), `${container}:/tmp/opencortex-migrations`]);
  run(runtime, [
    "exec",
    container,
    "bash",
    "-lc",
    [
      "set -euo pipefail",
      "for f in /tmp/opencortex-migrations/*.sql; do",
      "  echo \"applying $(basename \"$f\")\"",
      "  psql -U opencortex -d opencortex -v ON_ERROR_STOP=1 -f \"$f\" >/tmp/opencortex-migration.log",
      "done",
      "table_count=$(psql -U opencortex -d opencortex -t -A -c \"select count(*) from information_schema.tables where table_schema = 'public';\")",
      "test \"$table_count\" -ge 8",
      "role_count=$(psql -U opencortex -d opencortex -t -A -c \"select count(*) from pg_roles where rolname = 'opencortex_memory_api';\")",
      "test \"$role_count\" = 1",
      "echo \"created $table_count public tables\"",
    ].join("\n"),
  ]);
  verifySearchPath();
  verifyServiceKeyProvision();
  verifyLegacyHumanKeyWarnings();
} finally {
  run(runtime, ["rm", "-f", container], { allowFailure: true });
}

function findContainerRuntime() {
  for (const candidate of ["podman", "docker"]) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (result.status === 0) {
      return candidate;
    }
  }
  return "";
}

function waitForPostgres() {
  let readyCount = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync(runtime, [
      "exec",
      container,
      "pg_isready",
      "-U",
      "opencortex",
      "-d",
      "opencortex",
    ], { stdio: "ignore" });
    if (result.status === 0) {
      readyCount += 1;
      if (readyCount >= 2) {
        return;
      }
    } else {
      readyCount = 0;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error("Postgres did not become ready within 30 seconds");
}

function verifySearchPath() {
  const vector = `[${Array.from({ length: 768 }, (_, index) => index === 0 ? "1" : "0").join(",")}]`;
  const sql = `
    INSERT INTO entries (content, title, embedding, kind, scope, owner_id, author, content_hash)
    VALUES (
      'OpenCortex fresh install searchable memory fixture',
      'Fresh install search fixture',
      '${vector}'::vector,
      'thought',
      'personal',
      'fresh-owner',
      'user',
      'fresh-install-search-fixture'
    );

    SELECT id
    FROM search(
      'fresh install searchable memory',
      '${vector}'::vector,
      'fresh-owner',
      5,
      NULL,
      NULL,
      0.5,
      false,
      NULL
    )
    WHERE title = 'Fresh install search fixture'
      AND scope = 'personal';
  `;
  const result = spawnSync(runtime, [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "opencortex",
    "-d",
    "opencortex",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
  ], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (!result.stdout.trim()) {
    throw new Error("fresh-install hybrid search did not return the seeded 768-dim entry");
  }
  console.log("fresh-install hybrid search returned seeded 768-dim entry");
}

function verifyServiceKeyProvision() {
  const sql = `
    BEGIN;
    INSERT INTO keys (hash, owner_id, name, role)
    VALUES (encode(digest('fresh-admin-key', 'sha256'), 'hex'), 'fresh-admin', 'Fresh Admin', 'admin');
    SET LOCAL ROLE opencortex_memory_api;
    SELECT set_config('request.headers', '{"apikey":"fresh-admin-key"}', true);

    DO $$
    BEGIN
      BEGIN
        PERFORM provision('fresh-human', 'Fresh Human', 'member');
        RAISE EXCEPTION 'human key provision unexpectedly succeeded';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'human key issuance is disabled%' THEN
          RAISE;
        END IF;
      END;
    END;
    $$;

    SELECT provision('fresh-agent', 'Fresh Agent', 'agent');
    ROLLBACK;
  `;
  const result = spawnSync(runtime, [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "opencortex",
    "-d",
    "opencortex",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
  ], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (!result.stdout.trim()) {
    throw new Error("service-account provision did not return a key");
  }
  console.log("fresh-install provision allows service-account keys only");
}

function verifyLegacyHumanKeyWarnings() {
  const sql = `
    BEGIN;
    INSERT INTO keys (hash, owner_id, name, role)
    VALUES
      (encode(digest('fresh-member-key', 'sha256'), 'hex'), 'fresh-member', 'Fresh Member', 'member'),
      (encode(digest('fresh-agent-key', 'sha256'), 'hex'), 'fresh-agent', 'Fresh Agent', 'agent');
    SET LOCAL ROLE opencortex_memory_api;
    SELECT set_config('request.headers', '{"apikey":"fresh-member-key"}', true);
    SELECT request_owner_id();
    SELECT set_config('request.headers', '{"apikey":"fresh-agent-key"}', true);
    SELECT request_owner_id();
    ROLLBACK;
  `;
  const result = spawnSync(runtime, [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "opencortex",
    "-d",
    "opencortex",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
  ], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  const warnings = result.stderr.match(/legacy human memory key role/g) ?? [];
  if (warnings.length !== 1) {
    process.stderr.write(result.stderr);
    throw new Error(`expected one legacy human key warning, got ${warnings.length}`);
  }
  console.log("fresh-install legacy human key usage emits a deprecation warning");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (!options.allowFailure && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
