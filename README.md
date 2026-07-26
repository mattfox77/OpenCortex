# OpenCortex

OpenCortex is a self-hosted AI engineering control plane. It consolidates
BrainTrust, Diwan Runtime, Dyson OpenCode, and the existing Open Cortex/OB1
Temporal code into one platform for authenticated workspaces, durable memory,
agent session orchestration, review gates, artifacts, and operational telemetry.

This repository now uses the OpenCortex monorepo layout:

```text
packages/
  runtime/          # identity, sessions, chat, provisioning
  memory/           # Postgres memory schema, search, artifacts, scopes
  workbench/        # OpenCode workbench provider integration
  orchestrator/     # Temporal workflows, activities, worker runtime
  activity-ledger/  # optional activity and attribution rollups
  skills/           # versioned skill bundle publishing/provisioning
  ui/               # web console
deploy/             # podman Quadlet / systemd deployment profile
profiles/           # local-dev, staging-dex, external-oidc, dsn-internal
```

The previous OB1 Temporal worker/client/workflow code is preserved in
`packages/orchestrator` as the starting point for Cortex Orchestrator.

## Current Phase

Phase 0/1 guardrails are being established:

- monorepo package boundaries
- `@opencortex/orchestrator` as the first extracted package
- Node/npm boundary for the Temporal worker
- warning-mode config inventory for DSN/AWS/secret patterns
- root scripts that run package checks from a clean checkout

The target deployment profile is one self-hosted Linux host under Podman
Quadlet/systemd. OpenCortex has no cloud-vendor infrastructure dependency; the
coding agent's model provider is user-configured through OpenCode.

## Commands

```bash
npm --prefix packages/orchestrator install
npm run check
npm run build
```

`npm run config:inventory` reports DSN/AWS/secret-pattern findings in
warning mode. It becomes a hard gate after the neutralization phase.
