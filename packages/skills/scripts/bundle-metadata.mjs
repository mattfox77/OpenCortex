#!/usr/bin/env node
import { createHash, sign, verify } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MANIFEST_FILE = "opencortex-skills-manifest.json";
const INTEGRITY_FILE = "opencortex-skills-integrity.json";
const SIGNATURE_FILE = "opencortex-skills-signature.json";
const MANIFEST_VERSION = 1;
const INTEGRITY_ALGORITHM = "sha256";
const SIGNATURE_ALGORITHM = "ed25519";

const [command, bundleRootArg] = process.argv.slice(2);
const bundleRoot = bundleRootArg ? path.resolve(bundleRootArg) : "";

if (!command || !bundleRoot || !["create", "verify"].includes(command)) {
  console.error("usage: bundle-metadata.mjs <create|verify> <bundle-root>");
  process.exit(2);
}

try {
  if (command === "create") {
    await createBundleMetadata(bundleRoot);
  } else {
    await verifyBundleMetadata(bundleRoot);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function createBundleMetadata(root) {
  const skillsRoot = path.join(root, "skills");
  const files = await listBundleFiles(root, skillsRoot);
  if (files.length === 0) {
    throw new Error("skill bundle must include at least one file under skills/");
  }

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    id: env("OPENCORTEX_SKILLS_BUNDLE_ID", "opencortex-skills"),
    name: env("OPENCORTEX_SKILLS_BUNDLE_NAME", "OpenCortex Skills"),
    version: env("OPENCORTEX_SKILLS_BUNDLE_VERSION", "0.1.0-local"),
    description: env(
      "OPENCORTEX_SKILLS_BUNDLE_DESCRIPTION",
      "OpenCortex skill bundle for Codex and OpenCode provisioning",
    ),
    files,
    targets: env("OPENCORTEX_SKILLS_BUNDLE_TARGETS", "codex,opencode")
      .split(",")
      .map((target) => target.trim())
      .filter(Boolean),
  };

  if (process.env.OPENCORTEX_SKILLS_DEFERRED_IMPORT_REFERENCE) {
    manifest.deferredImport = {
      sourceSystem: "braintrust",
      migrationDeferred: true,
      reference: process.env.OPENCORTEX_SKILLS_DEFERRED_IMPORT_REFERENCE,
      reason:
        process.env.OPENCORTEX_SKILLS_DEFERRED_IMPORT_REASON ??
        "Legacy BrainTrust skill corpus migration is deferred; native bundle provisioning is active.",
    };
  }

  validateManifest(manifest);
  const integrity = calculateIntegrity(manifest);
  await writeJson(path.join(root, MANIFEST_FILE), manifest);
  await writeJson(path.join(root, INTEGRITY_FILE), integrity);

  const privateKey = await readKey("OPENCORTEX_SKILLS_PRIVATE_KEY_PEM", "OPENCORTEX_SKILLS_PRIVATE_KEY_FILE");
  if (privateKey) {
    await writeJson(path.join(root, SIGNATURE_FILE), {
      algorithm: SIGNATURE_ALGORITHM,
      keyId: env("OPENCORTEX_SKILLS_SIGNING_KEY_ID", "local"),
      signature: sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString("base64"),
    });
  } else if (process.env.OPENCORTEX_SKILLS_REQUIRE_SIGNATURE === "1") {
    throw new Error("OPENCORTEX_SKILLS_REQUIRE_SIGNATURE=1 but no private signing key was provided");
  }
}

async function verifyBundleMetadata(root) {
  const manifest = validateManifest(
    JSON.parse(await readFile(path.join(root, MANIFEST_FILE), "utf8")),
  );
  const integrity = JSON.parse(await readFile(path.join(root, INTEGRITY_FILE), "utf8"));
  if (
    integrity.algorithm !== INTEGRITY_ALGORITHM ||
    integrity.digest !== calculateIntegrity(manifest).digest
  ) {
    throw new Error("skill bundle integrity digest does not match manifest");
  }

  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  const actualFiles = await listBundleFiles(root, path.join(root, "skills"));
  for (const file of actualFiles) {
    if (!manifestPaths.has(file.path)) {
      throw new Error(`skill bundle contains unexpected file: ${file.path}`);
    }
  }
  if (manifestPaths.size !== actualFiles.length) {
    throw new Error("skill bundle manifest file list does not match archive contents");
  }
  for (const file of manifest.files) {
    const actual = actualFiles.find((candidate) => candidate.path === file.path);
    if (!actual || actual.sha256 !== file.sha256 || actual.sizeBytes !== file.sizeBytes) {
      throw new Error(`skill bundle file integrity mismatch: ${file.path}`);
    }
  }

  const publicKey = await readKey("OPENCORTEX_SKILLS_PUBLIC_KEY_PEM", "OPENCORTEX_SKILLS_PUBLIC_KEY_FILE");
  if (!publicKey) {
    if (process.env.OPENCORTEX_SKILLS_REQUIRE_SIGNATURE === "1") {
      throw new Error("OPENCORTEX_SKILLS_REQUIRE_SIGNATURE=1 but no public verification key was provided");
    }
    return;
  }

  const signaturePath = path.join(root, SIGNATURE_FILE);
  const signature = JSON.parse(await readFile(signaturePath, "utf8"));
  if (signature.algorithm !== SIGNATURE_ALGORITHM || typeof signature.signature !== "string") {
    throw new Error("skill bundle signature metadata is malformed");
  }
  if (
    !verify(
      null,
      Buffer.from(canonicalJson(manifest)),
      publicKey,
      Buffer.from(signature.signature, "base64"),
    )
  ) {
    throw new Error("skill bundle signature verification failed");
  }
}

async function listBundleFiles(root, dir) {
  const entries = [];
  await walk(dir, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));

  async function walk(current, output) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name.startsWith("._")) {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, output);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const contents = await readFile(absolute);
      const info = await stat(absolute);
      output.push({
        path: relative,
        sha256: createHash(INTEGRITY_ALGORITHM).update(contents).digest("hex"),
        sizeBytes: info.size,
      });
    }
  }
}

function validateManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("skill bundle manifest must be an object");
  }
  if (input.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(`skill bundle manifestVersion must be ${MANIFEST_VERSION}`);
  }
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(input.id)) {
    throw new Error("skill bundle id must be lowercase kebab-case, 3-64 characters");
  }
  for (const field of ["name", "version", "description"]) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new Error(`skill bundle ${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new Error("skill bundle files must be a non-empty array");
  }
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new Error("skill bundle targets must be a non-empty array");
  }
  for (const target of input.targets) {
    if (target !== "codex" && target !== "opencode") {
      throw new Error("skill bundle target must be codex or opencode");
    }
  }
  for (const file of input.files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.path !== "string" ||
      file.path.startsWith("/") ||
      file.path.includes("..") ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0
    ) {
      throw new Error("skill bundle file metadata is malformed");
    }
  }
  return input;
}

function calculateIntegrity(manifest) {
  return {
    algorithm: INTEGRITY_ALGORITHM,
    digest: createHash(INTEGRITY_ALGORITHM).update(canonicalJson(manifest)).digest("hex"),
  };
}

function canonicalJson(value) {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}

async function readKey(pemEnv, fileEnv) {
  if (process.env[pemEnv]) {
    return process.env[pemEnv];
  }
  if (process.env[fileEnv]) {
    return await readFile(process.env[fileEnv], "utf8");
  }
  return undefined;
}

function env(name, fallback) {
  return process.env[name] ?? fallback;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
