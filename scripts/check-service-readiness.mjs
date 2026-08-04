#!/usr/bin/env node
import net from "node:net";

const timeoutMs = Number(process.env.OPENCORTEX_READINESS_TIMEOUT_MS ?? "2000");

const checks = [
  httpCheck("runtime", process.env.OPENCORTEX_RUNTIME_HEALTH_URL ?? "http://127.0.0.1:8080/health"),
  httpCheck("dex", process.env.OPENCORTEX_DEX_HEALTH_URL ?? "http://127.0.0.1:5556/dex/.well-known/openid-configuration"),
  tcpCheck("postgres", process.env.OPENCORTEX_POSTGRES_HOST ?? "127.0.0.1", Number(process.env.OPENCORTEX_POSTGRES_PORT ?? "5432")),
  httpCheck("objects", process.env.OPENCORTEX_OBJECTS_HEALTH_URL ?? "http://127.0.0.1:8333/"),
  httpCheck("embeddings", process.env.OPENCORTEX_EMBEDDINGS_HEALTH_URL ?? "http://127.0.0.1:7997/health"),
  tcpCheck("temporal", process.env.OPENCORTEX_TEMPORAL_HOST ?? "127.0.0.1", Number(process.env.OPENCORTEX_TEMPORAL_PORT ?? "7233")),
  httpCheck("temporal-ui", process.env.OPENCORTEX_TEMPORAL_UI_HEALTH_URL ?? "http://127.0.0.1:8233/"),
  httpCheck("jaeger", process.env.OPENCORTEX_JAEGER_HEALTH_URL ?? "http://127.0.0.1:16686/"),
  httpCheck("otel-http", process.env.OPENCORTEX_OTEL_HEALTH_URL ?? "http://127.0.0.1:4318/", [404, 405]),
  tcpCheck("otel-grpc", process.env.OPENCORTEX_OTEL_GRPC_HOST ?? "127.0.0.1", Number(process.env.OPENCORTEX_OTEL_GRPC_PORT ?? "4317")),
];

const results = await Promise.all(checks.map(check => check()));
const failures = results.filter(result => !result.ok);

for (const result of results) {
  const prefix = result.ok ? "ok" : "fail";
  console.log(`${prefix}\t${result.name}\t${result.target}${result.message ? `\t${result.message}` : ""}`);
}

if (failures.length > 0) {
  process.exit(1);
}

function httpCheck(name, url, allowedStatuses = []) {
  return async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return {
        name,
        target: url,
        ok: (response.status >= 200 && response.status < 400) || allowedStatuses.includes(response.status),
        message: `status=${response.status}`,
      };
    } catch (error) {
      return {
        name,
        target: url,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

function tcpCheck(name, host, port) {
  return () =>
    new Promise(resolve => {
      const socket = net.createConnection({ host, port });
      const target = `${host}:${port}`;
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({ name, target, ok: false, message: "timeout" });
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timeout);
        socket.end();
        resolve({ name, target, ok: true });
      });
      socket.once("error", error => {
        clearTimeout(timeout);
        resolve({ name, target, ok: false, message: error.message });
      });
    });
}
