#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const sourceRoots = [
  join("packages", "runtime", "src"),
  join("packages", "orchestrator", "src"),
  join("packages", "orchestrator", "scripts"),
];

const forbidden = [
  /\bFROM\s+tasks\b/i,
  /\bJOIN\s+tasks\b/i,
  /\bINSERT\s+INTO\s+tasks\b/i,
  /\bUPDATE\s+tasks\b/i,
  /\bDELETE\s+FROM\s+tasks\b/i,
  /\btasks\.status\b/i,
];

const failures = [];

for (const root of sourceRoots) {
  for await (const file of walk(root)) {
    if (!/\.[cm]?[jt]s$/.test(file)) {
      continue;
    }
    const text = await readFile(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) {
        failures.push(`${file} matches ${pattern}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Workflow authority check failed:");
  console.error("Runtime/orchestrator code must read workflow_projection or Temporal, not legacy tasks.");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Workflow authority check: runtime/orchestrator do not read legacy tasks.");

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}
