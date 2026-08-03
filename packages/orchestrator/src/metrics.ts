import { createServer, type Server } from 'http';

const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type WorkerDbKey = {
  operation: string;
  status: 'ok' | 'error';
};

type HistogramStats = {
  count: number;
  sumSeconds: number;
  buckets: number[];
};

export class WorkerMetrics {
  private readonly startedAt = Date.now();
  private readonly dbQueries = new Map<string, HistogramStats>();
  private registered = 0;
  private heartbeats = 0;
  private heartbeatFailures = 0;

  constructor(
    private readonly workerName: string,
    private readonly taskQueues: string[],
  ) {}

  markRegistered(): void {
    this.registered = 1;
  }

  markHeartbeat(status: 'ok' | 'error'): void {
    if (status === 'ok') {
      this.heartbeats += 1;
    } else {
      this.heartbeatFailures += 1;
    }
  }

  async timeDbQuery<T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const started = process.hrtime.bigint();
    try {
      const result = await run();
      this.observeDbQuery({ operation, status: 'ok' }, elapsedSeconds(started));
      return result;
    } catch (error) {
      this.observeDbQuery({ operation, status: 'error' }, elapsedSeconds(started));
      throw error;
    }
  }

  render(): string {
    const lines = [
      '# HELP opencortex_worker_up Temporal worker process availability.',
      '# TYPE opencortex_worker_up gauge',
      `opencortex_worker_up{worker="${escapeLabel(this.workerName)}"} 1`,
      '# HELP opencortex_worker_uptime_seconds Temporal worker uptime in seconds.',
      '# TYPE opencortex_worker_uptime_seconds gauge',
      `opencortex_worker_uptime_seconds{worker="${escapeLabel(this.workerName)}"} ${((Date.now() - this.startedAt) / 1000).toFixed(3)}`,
      '# HELP opencortex_worker_registered Worker registration status in the memory database.',
      '# TYPE opencortex_worker_registered gauge',
      `opencortex_worker_registered{worker="${escapeLabel(this.workerName)}"} ${this.registered}`,
      '# HELP opencortex_worker_task_queue Worker task queue membership.',
      '# TYPE opencortex_worker_task_queue gauge',
      ...this.taskQueues.map(queue =>
        `opencortex_worker_task_queue{worker="${escapeLabel(this.workerName)}",task_queue="${escapeLabel(queue)}"} 1`,
      ),
      '# HELP opencortex_worker_heartbeats_total Worker heartbeat attempts by status.',
      '# TYPE opencortex_worker_heartbeats_total counter',
      `opencortex_worker_heartbeats_total{worker="${escapeLabel(this.workerName)}",status="ok"} ${this.heartbeats}`,
      `opencortex_worker_heartbeats_total{worker="${escapeLabel(this.workerName)}",status="error"} ${this.heartbeatFailures}`,
      '# HELP opencortex_worker_db_query_duration_seconds Worker Postgres query duration in seconds.',
      '# TYPE opencortex_worker_db_query_duration_seconds histogram',
    ];

    for (const [id, stats] of [...this.dbQueries.entries()].sort()) {
      const key = parseWorkerDbKeyId(id);
      const labels = workerDbLabels(this.workerName, key);
      for (const [index, bucket] of LATENCY_BUCKETS_SECONDS.entries()) {
        lines.push(
          `opencortex_worker_db_query_duration_seconds_bucket{${labels},le="${bucket}"} ${stats.buckets[index]}`,
        );
      }
      lines.push(
        `opencortex_worker_db_query_duration_seconds_bucket{${labels},le="+Inf"} ${stats.count}`,
        `opencortex_worker_db_query_duration_seconds_sum{${labels}} ${stats.sumSeconds.toFixed(6)}`,
        `opencortex_worker_db_query_duration_seconds_count{${labels}} ${stats.count}`,
      );
    }

    return `${lines.join('\n')}\n`;
  }

  private observeDbQuery(key: WorkerDbKey, durationSeconds: number): void {
    const id = workerDbKeyId(key);
    const stats =
      this.dbQueries.get(id) ??
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
    this.dbQueries.set(id, stats);
  }
}

export function startWorkerMetricsServer(
  metrics: WorkerMetrics,
  port: number,
): Server | undefined {
  if (port <= 0) {
    return undefined;
  }
  const server = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(metrics.render());
  });
  server.listen(port, '127.0.0.1');
  return server;
}

function elapsedSeconds(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000_000;
}

function workerDbKeyId(key: WorkerDbKey): string {
  return `${key.operation}\0${key.status}`;
}

function parseWorkerDbKeyId(id: string): WorkerDbKey {
  const [operation, status] = id.split('\0');
  return { operation, status: status as WorkerDbKey['status'] };
}

function workerDbLabels(workerName: string, key: WorkerDbKey): string {
  return [
    `worker="${escapeLabel(workerName)}"`,
    `operation="${escapeLabel(key.operation)}"`,
    `status="${key.status}"`,
  ].join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
