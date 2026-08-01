import assert from "node:assert/strict";
import test from "node:test";

import {
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
