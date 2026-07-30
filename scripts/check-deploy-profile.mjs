#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const quadletDir = join("deploy", "podman-quadlet");

const requiredFiles = [
  "opencortex-network.network",
  "opencortex-memory-db.container",
  "opencortex-memory-api.container",
  "opencortex-objects.container",
  "opencortex-embeddings.container",
  "opencortex-temporal.container",
  "opencortex-temporal-ui.container",
  "opencortex-dex.container",
  "opencortex-jaeger.container",
  "opencortex-otel.container",
];

const fileChecks = {
  "opencortex-memory-api.container": [
    "Environment=PGRST_DB_ANON_ROLE=opencortex_memory_api",
    "Network=opencortex.network",
  ],
  "opencortex-objects.container": [
    "ContainerName=opencortex-objects",
    "Exec=server -dir=/data -s3 -s3.port=8333 -volume.max=0",
    "PublishPort=127.0.0.1:8333:8333",
  ],
  "opencortex-embeddings.container": [
    "ContainerName=opencortex-embeddings",
    "Image=docker.io/michaelf34/infinity:latest-cpu",
    "Exec=v2 --model-id nomic-ai/nomic-embed-text-v1.5 --port 7997",
    "PublishPort=127.0.0.1:7997:7997",
  ],
  "opencortex-jaeger.container": [
    "ContainerName=opencortex-jaeger",
    "Image=docker.io/jaegertracing/all-in-one:1.76.0",
    "PublishPort=127.0.0.1:16686:16686",
  ],
  "opencortex-otel.container": [
    "ContainerName=opencortex-otel",
    "Image=docker.io/otel/opentelemetry-collector:0.157.0",
    "Volume=%h/.config/opencortex/otel-collector.yaml:/etc/otelcol/config.yaml:ro,Z",
    "PublishPort=127.0.0.1:4318:4318",
    "PublishPort=127.0.0.1:4317:4317",
  ],
  "opencortex-temporal.container": [
    "ContainerName=opencortex-temporal",
    "Environment=DB=postgres12",
    "Environment=DBNAME=opencortex_temporal",
    "Environment=VISIBILITY_DBNAME=opencortex_temporal_visibility",
  ],
};

const configChecks = {
  "config/env.example": [
    "OPENCORTEX_OIDC_SCOPES=openid,email,profile,groups",
    "OPENCORTEX_REQUIRED_GROUPS=CortexUsers",
  ],
  "config/dex.example.yaml": [
    "urn:ietf:params:oauth:grant-type:device_code",
    "id: opencortex-cli",
    "public: true",
    "enablePasswordDB: true",
    "staticPasswords:",
    "email: ada@opencortex.local",
    "email: grace@opencortex.local",
    "email: linus@opencortex.local",
    "CortexUsers",
  ],
};

const failures = [];

for (const file of requiredFiles) {
  let text = "";
  try {
    text = await readFile(join(quadletDir, file), "utf8");
  } catch {
    failures.push(`missing ${file}`);
    continue;
  }

  for (const expected of fileChecks[file] ?? []) {
    if (!text.includes(expected)) {
      failures.push(`${file} missing: ${expected}`);
    }
  }
}

for (const [file, checks] of Object.entries(configChecks)) {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    failures.push(`missing ${file}`);
    continue;
  }

  for (const expected of checks) {
    if (!text.includes(expected)) {
      failures.push(`${file} missing: ${expected}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Deploy profile check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Deploy profile check: required Quadlet units present.");
