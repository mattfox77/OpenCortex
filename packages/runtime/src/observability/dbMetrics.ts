const DB_LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type DbQueryKey = {
  store: string;
  operation: string;
  status: 'ok' | 'error';
};

type DbQueryStats = {
  count: number;
  sumSeconds: number;
  buckets: number[];
};

const dbQueries = new Map<string, DbQueryStats>();

export function observeDbQuery(
  key: DbQueryKey,
  durationSeconds: number,
): void {
  const id = dbQueryKeyId(key);
  const stats =
    dbQueries.get(id) ??
    {
      count: 0,
      sumSeconds: 0,
      buckets: DB_LATENCY_BUCKETS_SECONDS.map(() => 0),
    };
  stats.count += 1;
  stats.sumSeconds += durationSeconds;
  DB_LATENCY_BUCKETS_SECONDS.forEach((bucket, index) => {
    if (durationSeconds <= bucket) {
      stats.buckets[index] += 1;
    }
  });
  dbQueries.set(id, stats);
}

export async function timeDbQuery<T>(
  store: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = process.hrtime.bigint();
  try {
    const result = await run();
    observeDbQuery(
      { store, operation, status: 'ok' },
      elapsedSeconds(started),
    );
    return result;
  } catch (error) {
    observeDbQuery(
      { store, operation, status: 'error' },
      elapsedSeconds(started),
    );
    throw error;
  }
}

export function renderDbMetrics(): string[] {
  const lines = [
    '# HELP opencortex_runtime_db_query_duration_seconds Postgres query duration in seconds.',
    '# TYPE opencortex_runtime_db_query_duration_seconds histogram',
  ];
  for (const [id, stats] of [...dbQueries.entries()].sort()) {
    const key = parseDbQueryKeyId(id);
    for (const [index, bucket] of DB_LATENCY_BUCKETS_SECONDS.entries()) {
      lines.push(
        `opencortex_runtime_db_query_duration_seconds_bucket{${dbQueryLabels(key)},le="${bucket}"} ${stats.buckets[index]}`,
      );
    }
    lines.push(
      `opencortex_runtime_db_query_duration_seconds_bucket{${dbQueryLabels(key)},le="+Inf"} ${stats.count}`,
    );
    lines.push(
      `opencortex_runtime_db_query_duration_seconds_sum{${dbQueryLabels(key)}} ${stats.sumSeconds.toFixed(6)}`,
    );
    lines.push(
      `opencortex_runtime_db_query_duration_seconds_count{${dbQueryLabels(key)}} ${stats.count}`,
    );
  }
  return lines;
}

function elapsedSeconds(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000_000;
}

function dbQueryKeyId(key: DbQueryKey): string {
  return `${key.store}\0${key.operation}\0${key.status}`;
}

function parseDbQueryKeyId(id: string): DbQueryKey {
  const [store, operation, status] = id.split('\0');
  return { store, operation, status: status as DbQueryKey['status'] };
}

function dbQueryLabels(key: DbQueryKey): string {
  return [
    `store="${escapeLabel(key.store)}"`,
    `operation="${escapeLabel(key.operation)}"`,
    `status="${key.status}"`,
  ].join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
