export interface ActivityLedgerPolicy {
  enabled: boolean;
}

export interface ActivityEvent {
  id: string;
  actorId: string;
  kind: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  project?: string;
  workflowId?: string;
  sessionId?: string;
}

export interface ActivityRollupInput {
  policy: ActivityLedgerPolicy;
  rangeStart: string;
  rangeEnd: string;
  events: ActivityEvent[];
}

export interface ActivityRollupBucket {
  actorId: string;
  project?: string;
  kind: string;
  eventCount: number;
  durationSeconds: number;
  workflowIds: string[];
  sessionIds: string[];
}

export interface ActivityRollup {
  enabled: boolean;
  rangeStart: string;
  rangeEnd: string;
  eventCount: number;
  durationSeconds: number;
  buckets: ActivityRollupBucket[];
}

export function disabledActivityLedgerPolicy(): ActivityLedgerPolicy {
  return { enabled: false };
}

export function rollupActivity(input: ActivityRollupInput): ActivityRollup {
  if (!input.policy.enabled) {
    return {
      enabled: false,
      rangeStart: input.rangeStart,
      rangeEnd: input.rangeEnd,
      eventCount: 0,
      durationSeconds: 0,
      buckets: [],
    };
  }

  const rangeStart = Date.parse(input.rangeStart);
  const rangeEnd = Date.parse(input.rangeEnd);
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd < rangeStart) {
    throw new TypeError('Activity rollup range must be valid and ordered');
  }

  const buckets = new Map<string, ActivityRollupBucket>();
  for (const event of input.events) {
    if (!eventInRange(event, rangeStart, rangeEnd)) {
      continue;
    }
    const durationSeconds = eventDurationSeconds(event);
    const key = [event.actorId, event.project ?? '', event.kind].join('\u001f');
    const bucket =
      buckets.get(key) ??
      {
        actorId: event.actorId,
        ...(event.project ? { project: event.project } : {}),
        kind: event.kind,
        eventCount: 0,
        durationSeconds: 0,
        workflowIds: [],
        sessionIds: [],
      };
    bucket.eventCount += 1;
    bucket.durationSeconds += durationSeconds;
    pushUnique(bucket.workflowIds, event.workflowId);
    pushUnique(bucket.sessionIds, event.sessionId);
    buckets.set(key, bucket);
  }

  const sortedBuckets = [...buckets.values()].sort(bucketSort);
  return {
    enabled: true,
    rangeStart: input.rangeStart,
    rangeEnd: input.rangeEnd,
    eventCount: sortedBuckets.reduce((sum, bucket) => sum + bucket.eventCount, 0),
    durationSeconds: sortedBuckets.reduce(
      (sum, bucket) => sum + bucket.durationSeconds,
      0,
    ),
    buckets: sortedBuckets,
  };
}

function eventInRange(event: ActivityEvent, rangeStart: number, rangeEnd: number): boolean {
  const startedAt = Date.parse(event.startedAt);
  return Number.isFinite(startedAt) && startedAt >= rangeStart && startedAt < rangeEnd;
}

function eventDurationSeconds(event: ActivityEvent): number {
  if (event.durationSeconds !== undefined) {
    if (!Number.isFinite(event.durationSeconds) || event.durationSeconds < 0) {
      throw new TypeError('Activity event durationSeconds must be non-negative');
    }
    return Math.round(event.durationSeconds);
  }
  if (!event.endedAt) {
    return 0;
  }
  const startedAt = Date.parse(event.startedAt);
  const endedAt = Date.parse(event.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return 0;
  }
  return Math.round((endedAt - startedAt) / 1000);
}

function pushUnique(items: string[], item: string | undefined): void {
  if (item && !items.includes(item)) {
    items.push(item);
  }
}

function bucketSort(left: ActivityRollupBucket, right: ActivityRollupBucket): number {
  return (
    left.actorId.localeCompare(right.actorId) ||
    (left.project ?? '').localeCompare(right.project ?? '') ||
    left.kind.localeCompare(right.kind)
  );
}
