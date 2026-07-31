import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateSkillBundleIntegrity,
  signSkillBundleManifest,
  validateSkillBundleManifest,
  validateSkillBundleSignature,
  verifySkillBundleManifestSignature,
} from "../dist/index.js";

const manifest = validateSkillBundleManifest({
  manifestVersion: 1,
  id: "opencortex-skills",
  name: "OpenCortex Skills",
  version: "1.2.3",
  description: "OpenCortex skill bundle",
  files: [
    {
      path: "skills/example/SKILL.md",
      sha256: "a".repeat(64),
      sizeBytes: 42,
    },
  ],
  targets: ["codex", "opencode"],
});

test("signs and verifies skill bundle manifests with Ed25519", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature = signSkillBundleManifest(manifest, {
    keyId: "test-key",
    privateKey,
  });

  assert.deepEqual(validateSkillBundleSignature(signature), signature);
  assert.equal(signature.algorithm, "ed25519");
  assert.equal(verifySkillBundleManifestSignature(manifest, signature, publicKey), true);
});

test("rejects signatures for tampered manifests", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature = signSkillBundleManifest(manifest, {
    keyId: "test-key",
    privateKey,
  });
  const tampered = validateSkillBundleManifest({
    ...manifest,
    files: [{ ...manifest.files[0], sizeBytes: 43 }],
  });

  assert.equal(verifySkillBundleManifestSignature(tampered, signature, publicKey), false);
  assert.notEqual(
    calculateSkillBundleIntegrity(manifest).digest,
    calculateSkillBundleIntegrity(tampered).digest,
  );
});
