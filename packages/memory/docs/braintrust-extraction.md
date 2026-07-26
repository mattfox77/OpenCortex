# BrainTrust Extraction Notes

`packages/memory` carries forward BrainTrust's memory capability shape as code:
schema, hybrid search tables, scopes, review states, artifacts, hooks, and CLI
logic. It does not carry forward any existing BrainTrust rows or the author's
personal/DSN skill corpus.

The `migrations/` directory is a numbered version of the upstream BrainTrust SQL
sequence from `mattfox77/dyson-brain-trust` commit
`0881d6cb0c106f6186087767aa5c3159b1591118`.

Run the static migration check with:

```bash
npm --prefix packages/memory run check
```

To validate against a real empty pgvector database, install `psql` and provide:

```bash
OPENCORTEX_MEMORY_TEST_DATABASE_URL=postgres://user:pass@host:5432/db \
  npm --prefix packages/memory run check
```

Or run the containerized empty-database check, which requires Podman or Docker
but not a host `psql`:

```bash
npm --prefix packages/memory run check:empty-db
```

Skill bundle publishing remains in scope for `@opencortex/skills`. Importing or
migrating existing BrainTrust/DSN skill bundles is deliberately deferred.
