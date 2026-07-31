import {
  createHash,
  type KeyLike,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

export const SKILL_BUNDLE_MANIFEST_VERSION = 1 as const;
export const SKILL_BUNDLE_INTEGRITY_ALGORITHM = "sha256" as const;
export const SKILL_BUNDLE_SIGNATURE_ALGORITHM = "ed25519" as const;

export interface SkillBundleManifest {
  manifestVersion: typeof SKILL_BUNDLE_MANIFEST_VERSION;
  id: string;
  name: string;
  version: string;
  description: string;
  files: SkillBundleFile[];
  targets: SkillInstallTarget[];
  deferredImport?: DeferredSkillImport;
}

export interface SkillBundleFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export type SkillInstallTarget = "codex" | "opencode";

export interface DeferredSkillImport {
  sourceSystem: "braintrust";
  migrationDeferred: true;
  reference?: string;
  reason?: string;
}

export interface SkillBundleIntegrity {
  algorithm: typeof SKILL_BUNDLE_INTEGRITY_ALGORITHM;
  digest: string;
}

export interface SkillBundleSignature {
  algorithm: typeof SKILL_BUNDLE_SIGNATURE_ALGORITHM;
  keyId: string;
  signature: string;
}

export interface SignSkillBundleManifestOptions {
  keyId: string;
  privateKey: KeyLike;
}

export function validateSkillBundleManifest(input: unknown): SkillBundleManifest {
  if (!isRecord(input)) {
    throw new TypeError("Skill bundle manifest must be an object");
  }
  assertEqual(input.manifestVersion, SKILL_BUNDLE_MANIFEST_VERSION, "manifestVersion");
  const id = requiredString(input.id, "id");
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(id)) {
    throw new TypeError("Skill bundle id must be lowercase kebab-case, 3-64 characters");
  }
  const name = requiredString(input.name, "name");
  const version = requiredString(input.version, "version");
  const description = requiredString(input.description, "description");
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new TypeError("Skill bundle files must be a non-empty array");
  }
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new TypeError("Skill bundle targets must be a non-empty array");
  }

  return {
    manifestVersion: SKILL_BUNDLE_MANIFEST_VERSION,
    id,
    name,
    version,
    description,
    files: input.files.map(validateSkillBundleFile),
    targets: input.targets.map(validateSkillInstallTarget),
    ...(input.deferredImport === undefined
      ? {}
      : { deferredImport: validateDeferredSkillImport(input.deferredImport) }),
  };
}

export function validateSkillBundleSignature(input: unknown): SkillBundleSignature {
  if (!isRecord(input)) {
    throw new TypeError("Skill bundle signature must be an object");
  }
  assertEqual(input.algorithm, SKILL_BUNDLE_SIGNATURE_ALGORITHM, "signature.algorithm");
  const keyId = requiredString(input.keyId, "signature.keyId");
  if (!/^[a-zA-Z0-9_.:@/-]{1,128}$/.test(keyId)) {
    throw new TypeError("signature.keyId contains unsupported characters");
  }
  const signature = requiredString(input.signature, "signature.signature");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new TypeError("signature.signature must be base64");
  }
  return { algorithm: SKILL_BUNDLE_SIGNATURE_ALGORITHM, keyId, signature };
}

export function calculateSkillBundleIntegrity(manifest: SkillBundleManifest): SkillBundleIntegrity {
  return {
    algorithm: SKILL_BUNDLE_INTEGRITY_ALGORITHM,
    digest: createHash(SKILL_BUNDLE_INTEGRITY_ALGORITHM)
      .update(canonicalJson(manifest))
      .digest("hex"),
  };
}

export function signSkillBundleManifest(
  manifest: SkillBundleManifest,
  options: SignSkillBundleManifestOptions,
): SkillBundleSignature {
  const keyId = requiredString(options.keyId, "keyId");
  return validateSkillBundleSignature({
    algorithm: SKILL_BUNDLE_SIGNATURE_ALGORITHM,
    keyId,
    signature: signBytes(null, manifestPayload(manifest), options.privateKey).toString("base64"),
  });
}

export function verifySkillBundleManifestSignature(
  manifest: SkillBundleManifest,
  signature: SkillBundleSignature,
  publicKey: KeyLike,
): boolean {
  const validated = validateSkillBundleSignature(signature);
  return verifyBytes(
    null,
    manifestPayload(manifest),
    publicKey,
    Buffer.from(validated.signature, "base64"),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function manifestPayload(manifest: SkillBundleManifest): Buffer {
  return Buffer.from(canonicalJson(validateSkillBundleManifest(manifest)), "utf8");
}

function validateSkillBundleFile(input: unknown): SkillBundleFile {
  if (!isRecord(input)) {
    throw new TypeError("Skill bundle file must be an object");
  }
  const path = requiredString(input.path, "files[].path");
  if (path.startsWith("/") || path.includes("..")) {
    throw new TypeError("Skill bundle file paths must be relative and must not traverse directories");
  }
  const sha256 = requiredString(input.sha256, "files[].sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new TypeError("Skill bundle file sha256 must be a lowercase hex SHA-256 digest");
  }
  const sizeBytes = requiredNumber(input.sizeBytes, "files[].sizeBytes");
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new TypeError("Skill bundle file sizeBytes must be a non-negative safe integer");
  }
  return { path, sha256, sizeBytes };
}

function validateSkillInstallTarget(input: unknown): SkillInstallTarget {
  if (input === "codex" || input === "opencode") {
    return input;
  }
  throw new TypeError("Skill bundle target must be codex or opencode");
}

function validateDeferredSkillImport(input: unknown): DeferredSkillImport {
  if (!isRecord(input)) {
    throw new TypeError("deferredImport must be an object");
  }
  assertEqual(input.sourceSystem, "braintrust", "deferredImport.sourceSystem");
  assertEqual(input.migrationDeferred, true, "deferredImport.migrationDeferred");
  return {
    sourceSystem: "braintrust",
    migrationDeferred: true,
    ...(input.reference === undefined
      ? {}
      : { reference: requiredString(input.reference, "deferredImport.reference") }),
    ...(input.reason === undefined
      ? {}
      : { reason: requiredString(input.reason, "deferredImport.reason") }),
  };
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`${field} must be a number`);
  }
  return value;
}

function assertEqual<T>(actual: unknown, expected: T, field: string): asserts actual is T {
  if (actual !== expected) {
    throw new TypeError(`${field} must be ${String(expected)}`);
  }
}
