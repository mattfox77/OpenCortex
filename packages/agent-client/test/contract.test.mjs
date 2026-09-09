import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_CLIENT_PROTOCOL_VERSION,
  assertAgentCapabilities,
  normalizeAgentEvent,
  rawEventReference,
} from "../dist/index.js";

test("accepts provider capabilities that satisfy the base agent client contract", () => {
  assert.doesNotThrow(() =>
    assertAgentCapabilities({
      providerId: "claude-code",
      protocolVersion: AGENT_CLIENT_PROTOCOL_VERSION,
      controls: ["initialize", "resume", "request_status", "send_prompt"],
      eventKinds: ["session", "turn", "text", "question", "permission"],
      supportsMultipleAccounts: true,
      supportsNativeDeepLinks: true,
      supportsRemoteControl: true,
      supportsAcp: true,
    }),
  );
});

test("rejects provider capability version skew and missing required controls", () => {
  assert.throws(
    () =>
      assertAgentCapabilities({
        providerId: "codex",
        protocolVersion: "9.9",
        controls: ["initialize", "resume", "request_status"],
        eventKinds: ["session"],
        supportsMultipleAccounts: false,
        supportsNativeDeepLinks: false,
        supportsRemoteControl: false,
        supportsAcp: false,
      }),
    /Unsupported agent client protocol/,
  );

  assert.throws(
    () =>
      assertAgentCapabilities({
        providerId: "opencode",
        protocolVersion: AGENT_CLIENT_PROTOCOL_VERSION,
        controls: ["initialize"],
        eventKinds: ["session"],
        supportsMultipleAccounts: false,
        supportsNativeDeepLinks: false,
        supportsRemoteControl: false,
        supportsAcp: false,
      }),
    /missing required control: resume/,
  );
});

test("normalizes bounded raw provider references without embedding raw payloads", () => {
  const observedAt = "2026-09-09T22:00:00.000Z";
  const event = normalizeAgentEvent({
    id: "event_1",
    providerId: "claude-code",
    providerSessionId: "claude_session_1",
    workbenchId: "workbench_1",
    taskId: "task_1",
    kind: "tool_call",
    source: "acp",
    confidence: "authoritative",
    observedAt,
    payload: { toolName: "Read", path: "README.md" },
    raw: rawEventReference({
      providerId: "claude-code",
      providerEventId: "provider_event_1",
      capturedAt: observedAt,
      sizeBytes: 512,
      sha256: "abc123",
      artifactId: "artifact_1",
    }),
  });

  assert.equal(event.raw?.artifactId, "artifact_1");
  assert.equal(event.payload?.toolName, "Read");
});

test("rejects inline transcripts and raw provider payloads in normalized event payloads", () => {
  assert.throws(
    () =>
      normalizeAgentEvent({
        id: "event_2",
        providerId: "codex",
        providerSessionId: "codex_session_1",
        kind: "text",
        source: "provider",
        confidence: "authoritative",
        observedAt: "2026-09-09T22:00:00.000Z",
        payload: { transcript: "full provider transcript should not live here" },
      }),
    /raw provider payloads/,
  );
});
