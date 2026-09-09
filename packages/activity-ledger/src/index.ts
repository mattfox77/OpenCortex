export interface ActivityLedgerPolicy {
  enabled: boolean;
}

export interface ActivityEvent {
  id: string;
  tenantId?: string;
  actorId: string;
  kind: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  project?: string;
  workflowId?: string;
  taskId?: string;
  workbenchId?: string;
  sessionId?: string;
  providerSessionId?: string;
  source?: string;
  confidence?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentActivityEvent {
  id: string;
  providerId: string;
  providerSessionId: string;
  workbenchId?: string;
  taskId?: string;
  turnId?: string;
  kind: string;
  source: string;
  confidence: string;
  observedAt: string;
  sequence?: number;
  raw?: {
    providerEventId: string;
    artifactId?: string;
    sha256?: string;
    sizeBytes?: number;
  };
}

export interface AgentActivityEventInput {
  tenantId?: string;
  actorId: string;
  project?: string;
  workflowId?: string;
  event: AgentActivityEvent;
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

export function activityFromAgentEvent(
  input: AgentActivityEventInput,
): ActivityEvent {
  if (!input.actorId.trim()) {
    throw new TypeError('actorId is required');
  }
  if (!input.event.id.trim()) {
    throw new TypeError('agent event id is required');
  }
  if (!input.event.providerId.trim()) {
    throw new TypeError('agent event providerId is required');
  }
  if (!input.event.providerSessionId.trim()) {
    throw new TypeError('agent event providerSessionId is required');
  }
  if (!input.event.kind.trim()) {
    throw new TypeError('agent event kind is required');
  }
  if (
    !input.event.observedAt.trim() ||
    Number.isNaN(Date.parse(input.event.observedAt))
  ) {
    throw new TypeError('agent event observedAt must be an ISO timestamp');
  }

  return {
    id: input.event.id,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    actorId: input.actorId,
    kind: `agent.${input.event.kind}`,
    startedAt: input.event.observedAt,
    ...(input.project ? { project: input.project } : {}),
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(input.event.taskId ? { taskId: input.event.taskId } : {}),
    ...(input.event.workbenchId
      ? { workbenchId: input.event.workbenchId }
      : {}),
    sessionId: input.event.providerSessionId,
    providerSessionId: input.event.providerSessionId,
    source: input.event.source,
    confidence: input.event.confidence,
    metadata: {
      providerId: input.event.providerId,
      ...(input.event.turnId ? { turnId: input.event.turnId } : {}),
      ...(input.event.sequence !== undefined
        ? { sequence: input.event.sequence }
        : {}),
      ...(input.event.raw
        ? {
            rawProviderEventId: input.event.raw.providerEventId,
            ...(input.event.raw.artifactId
              ? { rawArtifactId: input.event.raw.artifactId }
              : {}),
            ...(input.event.raw.sha256
              ? { rawSha256: input.event.raw.sha256 }
              : {}),
            ...(input.event.raw.sizeBytes !== undefined
              ? { rawSizeBytes: input.event.raw.sizeBytes }
              : {}),
          }
        : {}),
    },
  };
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
