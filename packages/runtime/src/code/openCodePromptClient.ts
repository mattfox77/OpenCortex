import type { CodeSession } from './sessionLauncher.js';

export interface SendPromptInput {
  session: CodeSession;
  opencodeSessionId: string;
  promptText: string;
  draftId: string;
  approvedByEmail: string;
}

export interface SendPromptResult {
  openCodeMessageId?: string;
}

export interface OpenCodePromptClient {
  sendPrompt(input: SendPromptInput): Promise<SendPromptResult>;
}

export interface OpenCodeSessionSummary {
  id: string;
  name?: string;
  workspaceDir?: string;
}

export async function createOpenCodeSession(
  port: number,
  timeoutMs = 15000,
): Promise<string> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const primary = await postJson(
    `${baseUrl}/api/session`,
    undefined,
    timeoutMs,
  );
  if (primary.ok) {
    return sessionIdFromPayload(primary.payload);
  }
  if (primary.status !== 404) {
    throw new Error(primary.message);
  }

  const legacy = await postJson(`${baseUrl}/session`, undefined, timeoutMs);
  if (legacy.ok) {
    return sessionIdFromPayload(legacy.payload);
  }
  throw new Error(legacy.message);
}

export async function fetchOpenCodeSessionName(
  session: CodeSession,
  timeoutMs = 750,
): Promise<string | undefined> {
  return fetchOpenCodeSessionNameById(
    session,
    session.openCodeSessionId,
    timeoutMs,
  );
}

export async function fetchOpenCodeSessionNameById(
  session: CodeSession,
  openCodeSessionId: string | undefined,
  timeoutMs = 750,
): Promise<string | undefined> {
  if (!openCodeSessionId) {
    return undefined;
  }
  const baseUrl = `http://127.0.0.1:${session.port}`;
  const sessionPath = encodeURIComponent(openCodeSessionId);
  const primary = await getJson(
    `${baseUrl}/api/session/${sessionPath}`,
    timeoutMs,
  );
  if (primary.ok) {
    return sessionNameFromPayload(primary.payload);
  }
  if (primary.status !== 404) {
    return undefined;
  }

  const legacy = await getJson(`${baseUrl}/session/${sessionPath}`, timeoutMs);
  return legacy.ok ? sessionNameFromPayload(legacy.payload) : undefined;
}

export async function fetchOpenCodeSessions(
  session: CodeSession,
  timeoutMs = 1000,
): Promise<OpenCodeSessionSummary[] | undefined> {
  const baseUrl = `http://127.0.0.1:${session.port}`;
  const primary = await getJson(`${baseUrl}/api/session`, timeoutMs);
  if (primary.ok) {
    return sessionSummariesFromPayload(primary.payload);
  }
  if (primary.status !== 404) {
    return undefined;
  }

  const legacy = await getJson(`${baseUrl}/session`, timeoutMs);
  return legacy.ok ? sessionSummariesFromPayload(legacy.payload) : undefined;
}

export class HttpOpenCodePromptClient implements OpenCodePromptClient {
  constructor(private readonly timeoutMs = 15000) {}

  async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
    const payload = {
      parts: [{ type: 'text', text: input.promptText }],
    };
    const baseUrl = `http://127.0.0.1:${input.session.port}`;
    const sessionPath = encodeURIComponent(input.opencodeSessionId);
    const primary = `${baseUrl}/api/session/${sessionPath}/prompt_async`;
    const primarySync = `${baseUrl}/api/session/${sessionPath}/message`;
    const legacy = `${baseUrl}/session/${encodeURIComponent(input.opencodeSessionId)}/prompt_async`;

    const primaryResult = await postJson(primary, payload, this.timeoutMs);
    if (primaryResult.ok) {
      return messageResultFromPayload(primaryResult.payload);
    }
    if (primaryResult.status !== 404) {
      throw new Error(primaryResult.message);
    }

    const syncResult = await postJson(primarySync, payload, this.timeoutMs);
    if (syncResult.ok) {
      return messageResultFromPayload(syncResult.payload);
    }
    if (syncResult.status !== 404) {
      throw new Error(syncResult.message);
    }

    const legacyResult = await postJson(
      legacy,
      { ...payload, sessionID: input.opencodeSessionId },
      this.timeoutMs,
    );
    if (legacyResult.ok) {
      return messageResultFromPayload(legacyResult.payload);
    }
    throw new Error(legacyResult.message);
  }
}

async function postJson(
  url: string,
  payload: unknown,
  timeoutMs: number,
): Promise<
  | { ok: true; payload: Record<string, unknown> | undefined }
  | { ok: false; status: number; message: string }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers:
        payload === undefined
          ? undefined
          : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message:
          typeof parsed?.error === 'string'
            ? parsed.error
            : `OpenCode endpoint returned ${response.status}`,
      };
    }
    return { ok: true, payload: parsed };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message:
        error instanceof Error ? error.message : 'OpenCode request failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson(
  url: string,
  timeoutMs: number,
): Promise<
  | { ok: true; payload: Record<string, unknown> | undefined }
  | { ok: false; status: number; message: string }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message:
          typeof parsed?.error === 'string'
            ? parsed.error
            : `OpenCode endpoint returned ${response.status}`,
      };
    }
    return { ok: true, payload: parsed };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message:
        error instanceof Error ? error.message : 'OpenCode request failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sessionIdFromPayload(
  payload: Record<string, unknown> | undefined,
): string {
  const data =
    payload && typeof payload.data === 'object' && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : undefined;
  const id =
    typeof payload?.id === 'string'
      ? payload.id
      : typeof data?.id === 'string'
        ? data.id
        : undefined;
  if (!id) {
    throw new Error('OpenCode session creation did not return a session id');
  }
  return id;
}

function sessionNameFromPayload(payload: unknown): string | undefined {
  const root = recordValue(payload);
  const data = recordValue(root?.data);
  const session =
    data && typeof data.session === 'object' && data.session !== null
      ? (data.session as Record<string, unknown>)
      : undefined;
  const info =
    data && typeof data.info === 'object' && data.info !== null
      ? (data.info as Record<string, unknown>)
      : undefined;
  for (const source of [root, data, session, info]) {
    const name = stringValue(source, 'name') ?? stringValue(source, 'title');
    if (name) {
      return name;
    }
  }
  return undefined;
}

function sessionSummariesFromPayload(
  payload: unknown,
): OpenCodeSessionSummary[] {
  const records = sessionRecordList(payload);
  const summaries = records
    .map(record => {
      const id =
        stringValue(record, 'id') ??
        stringValue(record, 'sessionId') ??
        stringValue(record, 'sessionID');
      if (!id) {
        return undefined;
      }
      const name =
        stringValue(record, 'name') ??
        stringValue(record, 'title') ??
        stringValue(recordValue(record.info), 'name') ??
        stringValue(recordValue(record.info), 'title');
      const workspaceDir = workspaceDirFromRecord(record);
      return {
        id,
        ...(name ? { name } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
      } satisfies OpenCodeSessionSummary;
    })
    .filter((item): item is OpenCodeSessionSummary => item !== undefined);
  return uniqueById(summaries);
}

function workspaceDirFromRecord(
  record: Record<string, unknown>,
): string | undefined {
  const project = recordValue(record.project);
  const info = recordValue(record.info);
  const nestedProject = recordValue(info?.project);
  for (const source of [record, project, info, nestedProject]) {
    const workspaceDir =
      stringValue(source, 'workspaceDir') ??
      stringValue(source, 'workspace') ??
      stringValue(source, 'projectPath') ??
      stringValue(source, 'projectDir') ??
      stringValue(source, 'path') ??
      stringValue(source, 'cwd');
    if (workspaceDir?.startsWith('/')) {
      return workspaceDir;
    }
  }
  return undefined;
}

function sessionRecordList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  const root = recordValue(payload);
  if (!root) {
    return [];
  }
  for (const source of [root, recordValue(root.data)]) {
    if (!source) {
      continue;
    }
    for (const key of ['sessions', 'session', 'items', 'data']) {
      const value = source[key];
      if (Array.isArray(value)) {
        return value.filter(isRecord);
      }
    }
  }
  return [];
}

function uniqueById(
  summaries: OpenCodeSessionSummary[],
): OpenCodeSessionSummary[] {
  const seen = new Set<string>();
  const result: OpenCodeSessionSummary[] = [];
  for (const summary of summaries) {
    if (seen.has(summary.id)) {
      continue;
    }
    seen.add(summary.id);
    result.push(summary);
  }
  return result;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(
  source: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function messageResultFromPayload(
  payload: Record<string, unknown> | undefined,
): SendPromptResult {
  const data =
    payload && typeof payload.data === 'object' && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : undefined;
  const info =
    data && typeof data.info === 'object' && data.info !== null
      ? (data.info as Record<string, unknown>)
      : undefined;
  return {
    openCodeMessageId:
      typeof payload?.id === 'string'
        ? payload.id
        : typeof payload?.messageID === 'string'
          ? payload.messageID
          : typeof data?.id === 'string'
            ? data.id
            : typeof info?.id === 'string'
              ? info.id
              : undefined,
  };
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
