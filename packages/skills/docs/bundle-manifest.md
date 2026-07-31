# Skill Bundle Manifest

`@opencortex/skills` defines the neutral OpenCortex skill bundle manifest used
by later publishing and provisioning workflows.

Runtime publishing creates archives with a top-level `skills/` directory plus:

- `opencortex-skills-manifest.json`: versioned bundle metadata and file hashes.
- `opencortex-skills-integrity.json`: SHA-256 digest of the canonical manifest.
- `opencortex-skills-signature.json`: optional Ed25519 signature over the
  canonical manifest.

Set `OPENCORTEX_SKILLS_PRIVATE_KEY_FILE` or `OPENCORTEX_SKILLS_PRIVATE_KEY_PEM`
when publishing to sign the bundle. Set `OPENCORTEX_SKILLS_PUBLIC_KEY_FILE` or
`OPENCORTEX_SKILLS_PUBLIC_KEY_PEM` when deploying to verify the signature before
staging the bundle. Set `OPENCORTEX_SKILLS_REQUIRE_SIGNATURE=1` to reject
unsigned bundles in either path.

The skill bundle system is in scope for OpenCortex. Importing existing
BrainTrust or DSN skill corpuses is a separate, deferred compatibility tool and
is represented only as optional `deferredImport` metadata.
