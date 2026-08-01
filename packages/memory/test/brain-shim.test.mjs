import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const brainScript = new URL("../scripts/brain", import.meta.url).pathname;

test("brain shim migrates legacy config and delegates search to cortex", async () => {
  const fixture = await createFixture();
  await mkdir(join(fixture.home, ".braintrust"), { recursive: true });
  await writeFile(join(fixture.home, ".braintrust", "config"), "BT_URL=https://legacy.test\n");

  const result = await runBrain(["search", "auth redirect", "-n", "3"], fixture);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Migrated .*\.braintrust\/config/);
  assert.match(result.stderr, /brain is deprecated; use cortex/);
  assert.equal(
    await readFile(join(fixture.home, ".opencortex", "memory", "config"), "utf8"),
    "BT_URL=https://legacy.test\n",
  );
  assert.deepEqual(await readRecordedCall(fixture), {
    argv: ["memory", "search", "auth redirect", "-n", "3"],
    stdin: "",
  });
});

test("brain archive rescue delegates stdin to cortex memory sync", async () => {
  const fixture = await createFixture();

  const result = await runBrain(
    ["archive", "rescue", "-p", "runtime", "-s", "session-1"],
    fixture,
    "important transcript",
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readRecordedCall(fixture), {
    argv: [
      "memory",
      "sync",
      "run",
      "--source",
      "brain-archive",
      "-",
      "--title",
      "brain archive rescue",
      "--scope",
      "team",
      "--project",
      "runtime",
      "--session-id",
      "session-1",
    ],
    stdin: "important transcript",
  });
});

test("brain shim rejects unsupported legacy commands", async () => {
  const fixture = await createFixture();

  const result = await runBrain(["task", "list"], fixture);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /brain task is no longer supported/);
});

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "opencortex-brain-shim-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const calls = join(dir, "calls.jsonl");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  const cortex = join(bin, "cortex");
  await writeFile(
    cortex,
    `#!/usr/bin/env node
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input }) + "\\n");
console.log("cortex delegated");
`,
  );
  await chmod(cortex, 0o755);
  return { dir, home, bin, calls };
}

function runBrain(args, fixture, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(brainScript, args, {
      env: {
        ...process.env,
        HOME: fixture.home,
        PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", code => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function readRecordedCall(fixture) {
  const lines = (await readFile(fixture.calls, "utf8")).trim().split("\n");
  return JSON.parse(lines.at(-1));
}
