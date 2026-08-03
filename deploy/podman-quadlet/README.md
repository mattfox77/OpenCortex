# Podman Quadlet Deployment

These units are the primary single-host deployment profile for OpenCortex.
They are intentionally small Phase 0 scaffolds: enough to validate image
availability, Podman Quadlet syntax, networking, persistent volumes, and
secret injection on the target host.

Required secrets:

```bash
printf '%s' "$POSTGRES_PASSWORD" | podman secret create opencortex_postgres_password -
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
systemctl --user start opencortex-objects.service
systemctl --user start opencortex-embeddings.service
systemctl --user start opencortex-temporal.service
systemctl --user start opencortex-temporal-ui.service
systemctl --user start opencortex-jaeger.service
systemctl --user start opencortex-otel.service
```

PostgREST is not part of the deployment profile. Public memory access goes
through the OpenCortex API layer; internal services connect to Postgres with
`OPENCORTEX_MEMORY_DATABASE_URL`.

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
`4318`, then forwards traces to `opencortex-jaeger`. It also scrapes runtime
Prometheus metrics from the host service at `host.containers.internal:8080` and
Temporal worker metrics from host port `9464`. Configure services with
`OTEL_ENDPOINT=http://opencortex-otel:4318` inside the Quadlet network, or
`OTEL_ENDPOINT=http://localhost:4318` for local host processes. Jaeger UI is
available at `http://localhost:16686`.

Telemetry retention is deliberately bounded in this profile. Jaeger uses
in-memory storage with `MEMORY_MAX_TRACES=50000`, so trace retention is finite
and does not grow a persistent disk volume. The OTel collector config also uses
the `memory_limiter` processor with a 256 MiB limit before batching. Runtime and
worker metrics are scrape surfaces, not local time-series storage.

Each Quadlet container has a host-side `ExecStartPost` readiness gate for its
published localhost port. If the port never becomes reachable during startup,
systemd treats the unit start as failed and applies the unit restart policy.

Full-stack readiness after startup or restart can also be checked with:

```bash
npm run deploy:readiness
```

The readiness script probes the runtime health endpoint, Dex discovery,
Postgres, object storage, embeddings, Temporal, Temporal UI, Jaeger, and OTel
ports. Override its URLs and ports with the `OPENCORTEX_*_HEALTH_URL`,
`OPENCORTEX_*_HOST`, and `OPENCORTEX_*_PORT` environment variables when a
profile uses non-default port mappings.

TLS is intentionally not represented here. The staging host terminates HTTPS
with `tailscale serve` outside the container stack.
