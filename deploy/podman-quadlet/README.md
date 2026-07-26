# Podman Quadlet Deployment

These units are the primary single-host deployment profile for OpenCortex.
They are intentionally small Phase 0 scaffolds: enough to validate image
availability, Podman Quadlet syntax, networking, persistent volumes, and
secret injection on the target host.

Required secrets:

```bash
printf '%s' "$POSTGRES_PASSWORD" | podman secret create opencortex_postgres_password -
```

Install flow on the target host:

```bash
mkdir -p ~/.config/containers/systemd
cp deploy/podman-quadlet/* ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start opencortex-memory-db.service
systemctl --user start opencortex-objects.service
systemctl --user start opencortex-temporal.service
systemctl --user start opencortex-temporal-ui.service
```

TLS is intentionally not represented here. The staging host terminates HTTPS
with `tailscale serve` outside the container stack.
