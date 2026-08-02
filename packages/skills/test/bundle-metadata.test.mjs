import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("creates and verifies metadata for bundled neutral OpenCortex skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencortex-skills-bundle-"));
  try {
    await cp("skills", join(root, "skills"), { recursive: true });

    const create = spawnSync(
      process.execPath,
      ["scripts/bundle-metadata.mjs", "create", root],
      { encoding: "utf8" },
    );
    assert.equal(create.status, 0, create.stderr);

    const verify = spawnSync(
      process.execPath,
      ["scripts/bundle-metadata.mjs", "verify", root],
      { encoding: "utf8" },
    );
    assert.equal(verify.status, 0, verify.stderr);

    const manifest = JSON.parse(
      await readFile(join(root, "opencortex-skills-manifest.json"), "utf8"),
    );
    assert.equal(manifest.id, "opencortex-skills");
    assert.deepEqual(manifest.targets, ["codex", "opencode"]);
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      [
        "skills/opencortex-memory/SKILL.md",
        "skills/opencortex-workbench/SKILL.md",
      ],
    );
    assert.equal(manifest.deferredImport, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
