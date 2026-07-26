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
      "echo \"created $table_count public tables\"",
    ].join("\n"),
  ]);
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (!options.allowFailure && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
