import assert from "node:assert/strict";
import test from "node:test";

import {
  activityFromAgentEvent,
  disabledActivityLedgerPolicy,
  rollupActivity,
} from "../dist/index.js";

test("activity ledger is disabled by default policy", () => {
  const rollup = rollupActivity({
    policy: disabledActivityLedgerPolicy(),
    rangeStart: "2026-08-01T00:00:00.000Z",
    rangeEnd: "2026-08-02T00:00:00.000Z",
    events: [
      {
        id: "event-1",
        actorId: "owner@acme.test",
        kind: "session",
        startedAt: "2026-08-01T12:00:00.000Z",
        durationSeconds: 60,
      },
    ],
  });

  assert.deepEqual(rollup, {
    enabled: false,
    rangeStart: "2026-08-01T00:00:00.000Z",
    rangeEnd: "2026-08-02T00:00:00.000Z",
    eventCount: 0,
    durationSeconds: 0,
    buckets: [],
  });
});

test("converts normalized agent events into bounded activity events", () => {
  const event = activityFromAgentEvent({
    tenantId: "tenant-1",
    actorId: "owner@acme.test",
    project: "runtime",
    workflowId: "workflow-1",
    event: {
      id: "agent-event-1",
      providerId: "codex",
      providerSessionId: "provider-session-1",
      workbenchId: "workbench-1",
      taskId: "task-1",
      turnId: "turn-1",
      kind: "tool_call",
      source: "acp",
      confidence: "authoritative",
      observedAt: "2026-08-01T10:00:00.000Z",
      sequence: 7,
      raw: {
        providerEventId: "raw-event-1",
        artifactId: "artifact-1",
        sha256: "abc123",
        sizeBytes: 1024,
      },
    },
  });

  assert.deepEqual(event, {
    id: "agent-event-1",
    tenantId: "tenant-1",
    actorId: "owner@acme.test",
    kind: "agent.tool_call",
    startedAt: "2026-08-01T10:00:00.000Z",
    project: "runtime",
    workflowId: "workflow-1",
    taskId: "task-1",
    workbenchId: "workbench-1",
    sessionId: "provider-session-1",
    providerSessionId: "provider-session-1",
    source: "acp",
    confidence: "authoritative",
    metadata: {
      providerId: "codex",
      turnId: "turn-1",
      sequence: 7,
      rawProviderEventId: "raw-event-1",
      rawArtifactId: "artifact-1",
      rawSha256: "abc123",
      rawSizeBytes: 1024,
    },
  });
});

test("rejects agent activity without stable actor or event timestamps", () => {
  assert.throws(
    () =>
      activityFromAgentEvent({
        actorId: " ",
        event: {
          id: "agent-event-1",
          providerId: "codex",
          providerSessionId: "provider-session-1",
          kind: "session",
          source: "acp",
          confidence: "authoritative",
          observedAt: "2026-08-01T10:00:00.000Z",
        },
      }),
    /actorId is required/,
  );

  assert.throws(
    () =>
      activityFromAgentEvent({
        actorId: "owner@acme.test",
        event: {
          id: "agent-event-1",
          providerId: "codex",
          providerSessionId: "provider-session-1",
          kind: "session",
          source: "acp",
          confidence: "authoritative",
          observedAt: "not-a-date",
        },
      }),
    /observedAt must be an ISO timestamp/,
  );
});

test("rolls up enabled activity by actor project and kind", () => {
  const rollup = rollupActivity({
    policy: { enabled: true },
    rangeStart: "2026-08-01T00:00:00.000Z",
    rangeEnd: "2026-08-02T00:00:00.000Z",
    events: [
      {
        id: "event-1",
        actorId: "owner@acme.test",
        kind: "session",
        project: "runtime",
        workflowId: "workflow-1",
        sessionId: "session-1",
        startedAt: "2026-08-01T10:00:00.000Z",
        endedAt: "2026-08-01T10:05:00.000Z",
      },
      {
        id: "event-2",
        actorId: "owner@acme.test",
        kind: "session",
        project: "runtime",
        workflowId: "workflow-1",
        sessionId: "session-1",
        startedAt: "2026-08-01T11:00:00.000Z",
        durationSeconds: 30,
      },
      {
        id: "event-outside-range",
        actorId: "owner@acme.test",
        kind: "session",
        project: "runtime",
        startedAt: "2026-08-02T00:00:00.000Z",
        durationSeconds: 999,
      },
    ],
  });

  assert.equal(rollup.enabled, true);
  assert.equal(rollup.eventCount, 2);
  assert.equal(rollup.durationSeconds, 330);
  assert.deepEqual(rollup.buckets, [
    {
      actorId: "owner@acme.test",
      project: "runtime",
      kind: "session",
      eventCount: 2,
      durationSeconds: 330,
      workflowIds: ["workflow-1"],
      sessionIds: ["session-1"],
    },
  ]);
});

test("rejects invalid enabled rollup ranges", () => {
  assert.throws(
    () =>
      rollupActivity({
        policy: { enabled: true },
        rangeStart: "2026-08-02T00:00:00.000Z",
        rangeEnd: "2026-08-01T00:00:00.000Z",
        events: [],
      }),
    /valid and ordered/,
  );
});
