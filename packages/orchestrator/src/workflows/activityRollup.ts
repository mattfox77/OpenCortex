export interface ActivityRollupPolicy {
  enabled: boolean;
}

export interface ActivityRollupEvent {
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
  policy: ActivityRollupPolicy;
  rangeStart: string;
  rangeEnd: string;
  events: ActivityRollupEvent[];
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

export interface ActivityRollupResult {
  enabled: boolean;
  rangeStart: string;
  rangeEnd: string;
  eventCount: number;
  durationSeconds: number;
  buckets: ActivityRollupBucket[];
}

export async function activityRollupWorkflow(
  input: ActivityRollupInput,
): Promise<ActivityRollupResult> {
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
    const startedAt = Date.parse(event.startedAt);
    if (!Number.isFinite(startedAt) || startedAt < rangeStart || startedAt >= rangeEnd) {
      continue;
    }
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
    bucket.durationSeconds += eventDurationSeconds(event);
    pushUnique(bucket.workflowIds, event.workflowId);
    pushUnique(bucket.sessionIds, event.sessionId);
    buckets.set(key, bucket);
  }

  const sorted = [...buckets.values()].sort(
    (left, right) =>
      left.actorId.localeCompare(right.actorId) ||
      (left.project ?? '').localeCompare(right.project ?? '') ||
      left.kind.localeCompare(right.kind),
  );
  return {
    enabled: true,
    rangeStart: input.rangeStart,
    rangeEnd: input.rangeEnd,
    eventCount: sorted.reduce((sum, bucket) => sum + bucket.eventCount, 0),
    durationSeconds: sorted.reduce((sum, bucket) => sum + bucket.durationSeconds, 0),
    buckets: sorted,
  };
}

function eventDurationSeconds(event: ActivityRollupEvent): number {
  if (event.durationSeconds !== undefined) {
    return Math.max(0, Math.round(event.durationSeconds));
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
