export const AGENT_CLIENT_PROTOCOL_VERSION = "0.1" as const;

export const KNOWN_AGENT_PROVIDER_IDS = [
  "claude-code",
  "codex",
  "opencode",
] as const;

export type KnownAgentProviderId = (typeof KNOWN_AGENT_PROVIDER_IDS)[number];
export type AgentProviderId = KnownAgentProviderId | (string & {});

export type AgentControlCapability =
  | "initialize"
  | "resume"
  | "send_prompt"
  | "stream_events"
  | "answer_question"
  | "decide_permission"
  | "request_status"
  | "interrupt"
  | "compact"
  | "terminate"
  | "native_link";

export type AgentEventKind =
  | "session"
  | "turn"
  | "text"
  | "thought_summary"
  | "tool_call"
  | "subagent"
  | "file_touch"
  | "question"
  | "permission"
  | "diff"
  | "usage"
  | "cost"
  | "completion"
  | "interruption"
  | "disconnection"
  | "error";

export type AgentEventSource = "acp" | "provider" | "herdr" | "opencortex";
export type AgentEventConfidence = "authoritative" | "inferred" | "estimated" | "unknown";

export interface AgentRawEventReference {
  providerId: AgentProviderId;
  providerEventId: string;
  capturedAt: string;
  sizeBytes?: number;
  sha256?: string;
  artifactId?: string;
}

export interface NormalizedAgentEvent {
  id: string;
  providerId: AgentProviderId;
  providerSessionId: string;
  workbenchId?: string;
  taskId?: string;
  turnId?: string;
  kind: AgentEventKind;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  observedAt: string;
  sequence?: number;
  summary?: string;
  payload?: Record<string, unknown>;
  raw?: AgentRawEventReference;
}

export type AgentSessionLifecycleState =
  | "initializing"
  | "running"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "paused"
  | "interrupted"
  | "completed"
  | "failed"
  | "disconnected"
  | "terminated";

export interface AgentSessionState {
  providerId: AgentProviderId;
  providerSessionId: string;
  lifecycle: AgentSessionLifecycleState;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  observedAt: string;
  nativeUrl?: string;
  fallbackUrl?: string;
  currentTurnId?: string;
  statusText?: string;
}

export interface AgentProviderCapabilities {
  providerId: AgentProviderId;
  protocolVersion: string;
  providerVersion?: string;
  controls: AgentControlCapability[];
  eventKinds: AgentEventKind[];
  models?: AgentModelCapability[];
  supportsMultipleAccounts: boolean;
  supportsNativeDeepLinks: boolean;
  supportsRemoteControl: boolean;
  supportsAcp: boolean;
}

export interface AgentModelCapability {
  id: string;
  displayName?: string;
  effortModes?: string[];
  permissionModes?: string[];
}

export interface AgentAccountContext {
  id: string;
  displayName?: string;
}

export interface AgentInitializeInput {
  tenantId: string;
  taskId: string;
  workbenchId: string;
  ownerId: string;
  workingDirectory: string;
  initialPrompt: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  account?: AgentAccountContext;
  metadata?: Record<string, unknown>;
}

export interface AgentResumeInput {
  providerSessionId: string;
  workbenchId?: string;
  account?: AgentAccountContext;
}

export interface AgentSessionDescriptor {
  providerId: AgentProviderId;
  providerSessionId: string;
  workbenchId: string;
  taskId: string;
  account?: AgentAccountContext;
  nativeUrl?: string;
  fallbackUrl?: string;
  resumeToken?: string;
  state: AgentSessionState;
}

export interface AgentPromptInput {
  providerSessionId: string;
  commandId: string;
  prompt: string;
  attachments?: AgentPromptAttachment[];
}

export interface AgentPromptAttachment {
  artifactId: string;
  mediaType?: string;
  description?: string;
}

export interface AgentQuestionAnswerInput {
  providerSessionId: string;
  commandId: string;
  questionId: string;
  answer: string;
}

export interface AgentPermissionDecisionInput {
  providerSessionId: string;
  commandId: string;
  permissionRequestId: string;
  decision: "approve" | "deny";
  reason?: string;
}

export interface AgentCommandAck {
  commandId: string;
  accepted: boolean;
  duplicate: boolean;
  reason?: string;
}

export interface AgentClient {
  readonly providerId: AgentProviderId;
  capabilities(): Promise<AgentProviderCapabilities>;
  initialize(input: AgentInitializeInput): Promise<AgentSessionDescriptor>;
  resume(input: AgentResumeInput): Promise<AgentSessionDescriptor>;
  sendPrompt(input: AgentPromptInput): Promise<AgentCommandAck>;
  streamEvents(input: AgentResumeInput): AsyncIterable<NormalizedAgentEvent>;
  answerQuestion(input: AgentQuestionAnswerInput): Promise<AgentCommandAck>;
  decidePermission(input: AgentPermissionDecisionInput): Promise<AgentCommandAck>;
  requestStatus(input: AgentResumeInput): Promise<AgentSessionState>;
  interrupt(input: AgentResumeInput & { commandId: string }): Promise<AgentCommandAck>;
  compact(input: AgentResumeInput & { commandId: string }): Promise<AgentCommandAck>;
  terminate(input: AgentResumeInput & { commandId: string }): Promise<AgentCommandAck>;
}

export function rawEventReference(input: AgentRawEventReference): AgentRawEventReference {
  if (!input.providerEventId.trim()) {
    throw new TypeError("providerEventId is required");
  }
  if (!input.capturedAt.trim() || Number.isNaN(Date.parse(input.capturedAt))) {
    throw new TypeError("capturedAt must be an ISO timestamp");
  }
  if (input.sizeBytes !== undefined && (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0)) {
    throw new TypeError("sizeBytes must be a non-negative integer");
  }
  return { ...input };
}

export function normalizeAgentEvent(input: NormalizedAgentEvent): NormalizedAgentEvent {
  if (!input.id.trim()) {
    throw new TypeError("event id is required");
  }
  if (!input.providerSessionId.trim()) {
    throw new TypeError("providerSessionId is required");
  }
  if (!input.observedAt.trim() || Number.isNaN(Date.parse(input.observedAt))) {
    throw new TypeError("observedAt must be an ISO timestamp");
  }
  assertNoInlineRawPayload(input.payload);
  return {
    ...input,
    raw: input.raw ? rawEventReference(input.raw) : undefined,
  };
}

export function assertAgentCapabilities(capabilities: AgentProviderCapabilities): void {
  if (capabilities.protocolVersion !== AGENT_CLIENT_PROTOCOL_VERSION) {
    throw new TypeError(
      `Unsupported agent client protocol ${capabilities.protocolVersion}; expected ${AGENT_CLIENT_PROTOCOL_VERSION}`,
    );
  }
  for (const required of ["initialize", "resume", "request_status"] as const) {
    if (!capabilities.controls.includes(required)) {
      throw new TypeError(`Agent provider is missing required control: ${required}`);
    }
  }
}

function assertNoInlineRawPayload(payload: Record<string, unknown> | undefined): void {
  if (!payload) {
    return;
  }
  for (const key of Object.keys(payload)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "raw" || normalizedKey === "rawpayload" || normalizedKey === "transcript") {
      throw new TypeError("raw provider payloads must be stored as artifact references");
    }
  }
}
