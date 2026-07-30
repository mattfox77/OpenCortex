# Podman Quadlet Deployment

These units are the primary single-host deployment profile for OpenCortex.
They are intentionally small Phase 0 scaffolds: enough to validate image
availability, Podman Quadlet syntax, networking, persistent volumes, and
secret injection on the target host.

Required secrets:

```bash
printf '%s' "$POSTGRES_PASSWORD" | podman secret create opencortex_postgres_password -
printf '%s' "postgres://opencortex:${POSTGRES_PASSWORD}@opencortex-memory-db:5432/opencortex_memory" | podman secret create opencortex_memory_db_uri -
printf '%s' "$MEMORY_JWT_SECRET" | podman secret create opencortex_memory_jwt_secret -
printf '%s' "$DEX_CLIENT_SECRET" | podman secret create opencortex_dex_client_secret -
```

Install flow on the target host:

```bash
mkdir -p ~/.config/containers/systemd
cp deploy/podman-quadlet/* ~/.config/containers/systemd/
mkdir -p ~/.config/opencortex
cp config/dex.example.yaml ~/.config/opencortex/dex.yaml
cp config/otel-collector.yaml ~/.config/opencortex/otel-collector.yaml
systemctl --user daemon-reload
systemctl --user start opencortex-dex.service
systemctl --user start opencortex-memory-db.service
systemctl --user start opencortex-memory-api.service
systemctl --user start opencortex-objects.service
systemctl --user start opencortex-embeddings.service
systemctl --user start opencortex-temporal.service
systemctl --user start opencortex-temporal-ui.service
systemctl --user start opencortex-jaeger.service
systemctl --user start opencortex-otel.service
```

`opencortex-memory-api` is PostgREST and is intentionally internal-only. It
joins `opencortex.network` and does not publish port `3000` to the host. Public
memory access must go through the OpenCortex API layer.

`opencortex-temporal` uses the same Postgres container, but stores Temporal data
in `opencortex_temporal` and visibility data in
`opencortex_temporal_visibility`. Memory application tables stay in
`opencortex_memory`.

`opencortex-dex` is the bundled OIDC issuer for local and staging profiles. The
default issuer URL is `http://localhost:5556/dex`, matching the host-local
runtime and CLI example configuration. The runtime uses the same OIDC
implementation for Dex and external compliant issuers such as Google; configure
`OPENCORTEX_OIDC_ISSUER` and client settings per profile. The bundled config
includes a confidential `opencortex-runtime` web client and a public
`opencortex-cli` client with the device-code grant enabled for CLI login. Dex
publishes only `127.0.0.1:5556` by default.

`opencortex-embeddings` runs Infinity's CPU image with
`nomic-ai/nomic-embed-text-v1.5` and publishes only `127.0.0.1:7997` for local
development. In-container callers use
`http://opencortex-embeddings:7997/v1/embeddings`.

`opencortex-otel` accepts OTLP/gRPC and OTLP/HTTP on localhost ports `4317` and
`4318`, then forwards traces to `opencortex-jaeger`. Configure services with
`OTEL_ENDPOINT=http://opencortex-otel:4318` inside the Quadlet network, or
`OTEL_ENDPOINT=http://localhost:4318` for local host processes. Jaeger UI is
available at `http://localhost:16686`.

TLS is intentionally not represented here. The staging host terminates HTTPS
with `tailscale serve` outside the container stack.
