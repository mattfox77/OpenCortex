import type express from 'express';
import type { SessionStore } from '../code/sessionStore.js';

const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type RequestKey = {
  method: string;
  route: string;
  statusCode: number;
};

type RequestStats = {
  count: number;
  sumSeconds: number;
  buckets: number[];
};

export class RuntimeMetrics {
  private readonly startedAt = Date.now();
  private readonly requests = new Map<string, RequestStats>();

  observeRequest(key: RequestKey, durationSeconds: number): void {
    const id = requestKeyId(key);
    const stats =
      this.requests.get(id) ??
      {
        count: 0,
        sumSeconds: 0,
        buckets: LATENCY_BUCKETS_SECONDS.map(() => 0),
      };
    stats.count += 1;
    stats.sumSeconds += durationSeconds;
    LATENCY_BUCKETS_SECONDS.forEach((bucket, index) => {
      if (durationSeconds <= bucket) {
        stats.buckets[index] += 1;
      }
    });
    this.requests.set(id, stats);
  }

  render(sessions: SessionStore): string {
    const lines = [
      '# HELP opencortex_runtime_up Runtime process availability.',
      '# TYPE opencortex_runtime_up gauge',
      'opencortex_runtime_up 1',
      '# HELP opencortex_runtime_uptime_seconds Runtime process uptime in seconds.',
      '# TYPE opencortex_runtime_uptime_seconds gauge',
      `opencortex_runtime_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(3)}`,
      '# HELP opencortex_runtime_sessions_active Active code sessions known to the runtime.',
      '# TYPE opencortex_runtime_sessions_active gauge',
      `opencortex_runtime_sessions_active ${[...sessions.values()].length}`,
      '# HELP opencortex_runtime_http_requests_total HTTP requests handled by the runtime.',
      '# TYPE opencortex_runtime_http_requests_total counter',
    ];

    for (const [id, stats] of [...this.requests.entries()].sort()) {
      const key = parseRequestKeyId(id);
      const labels = requestLabels(key);
      lines.push(`opencortex_runtime_http_requests_total{${labels}} ${stats.count}`);
    }

    lines.push(
      '# HELP opencortex_runtime_http_request_duration_seconds HTTP request duration in seconds.',
      '# TYPE opencortex_runtime_http_request_duration_seconds histogram',
    );
    for (const [id, stats] of [...this.requests.entries()].sort()) {
      const key = parseRequestKeyId(id);
      for (const [index, bucket] of LATENCY_BUCKETS_SECONDS.entries()) {
        lines.push(
          `opencortex_runtime_http_request_duration_seconds_bucket{${requestLabels(key)},le="${bucket}"} ${stats.buckets[index]}`,
        );
      }
      lines.push(
        `opencortex_runtime_http_request_duration_seconds_bucket{${requestLabels(key)},le="+Inf"} ${stats.count}`,
      );
      lines.push(
        `opencortex_runtime_http_request_duration_seconds_sum{${requestLabels(key)}} ${stats.sumSeconds.toFixed(6)}`,
      );
      lines.push(
        `opencortex_runtime_http_request_duration_seconds_count{${requestLabels(key)}} ${stats.count}`,
      );
    }

    return `${lines.join('\n')}\n`;
  }
}

export function runtimeMetricsMiddleware(metrics: RuntimeMetrics): express.RequestHandler {
  return (req, res, next) => {
    if (req.path.endsWith('/metrics')) {
      return next();
    }
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedNs = process.hrtime.bigint() - started;
      metrics.observeRequest(
        {
          method: req.method,
          route: routeLabel(req),
          statusCode: res.statusCode,
        },
        Number(elapsedNs) / 1_000_000_000,
      );
    });
    next();
  };
}

function routeLabel(req: express.Request): string {
  const routePath = routePathValue(req.route?.path);
  if (routePath) {
    return `${req.baseUrl}${routePath}`;
  }
  return normalizePath(req.path);
}

function routePathValue(path: unknown): string {
  if (typeof path === 'string') {
    return path;
  }
  if (Array.isArray(path) && typeof path[0] === 'string') {
    return path[0];
  }
  return '';
}

function normalizePath(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\/[A-Za-z0-9_-]{12,}(?=\/|$)/g, '/:id');
}

function requestKeyId(key: RequestKey): string {
  return `${key.method}\0${key.route}\0${key.statusCode}`;
}

function parseRequestKeyId(id: string): RequestKey {
  const [method, route, statusCode] = id.split('\0');
  return { method, route, statusCode: Number(statusCode) };
}

function requestLabels(key: RequestKey): string {
  return [
    `method="${escapeLabel(key.method)}"`,
    `route="${escapeLabel(key.route)}"`,
    `status_code="${key.statusCode}"`,
  ].join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
