import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { AuthenticatedUser } from '../auth/types.js';
import type { CodeSession } from '../code/sessionLauncher.js';

export type PairPromptStatus =
  | 'editing'
  | 'ready'
  | 'sending'
  | 'sent'
  | 'rejected'
  | 'failed';

export interface PairPromptDraft {
  id: string;
  channelId: string;
  diwanSessionId: string;
  opencodeSessionId?: string;
  createdAt: string;
  createdByEmail: string;
  createdByLinuxUser: string;
  status: PairPromptStatus;
  draftText: string;
  readyByEmail?: string;
  readyAt?: string;
  reviewSnapshotText?: string;
  reviewSnapshotHash?: string;
  reviewedByEmail?: string;
  reviewedAt?: string;
  rejectedReason?: string;
  sendingStartedAt?: string;
  sentAt?: string;
  failedAt?: string;
  failureCode?: string;
  failureMessage?: string;
  retryCount: number;
  openCodeMessageId?: string;
}

type PairPromptEvent =
  | { type: 'created'; draft: PairPromptDraft }
  | {
      type: 'textUpdated';
      draftId: string;
      updatedByEmail: string;
      updatedAt: string;
      text: string;
    }
  | {
      type: 'ready';
      draftId: string;
      readyByEmail: string;
      readyAt: string;
      snapshotText: string;
      snapshotHash: string;
    }
  | {
      type: 'reopened';
      draftId: string;
      reopenedByEmail: string;
      reopenedAt: string;
      reason?: string;
    }
  | {
      type: 'rejected';
      draftId: string;
      reviewedByEmail: string;
      reviewedAt: string;
      reason?: string;
    }
  | { type: 'sending'; draftId: string; sendingStartedAt: string }
  | {
      type: 'sent';
      draftId: string;
      sentAt: string;
      reviewedByEmail: string;
      openCodeMessageId?: string;
    }
  | {
      type: 'failed';
      draftId: string;
      failedAt: string;
      reviewedByEmail?: string;
      failureCode: string;
      failureMessage: string;
    };

const maxPromptBytes = 64 * 1024;

export class PairPromptStore {
  private readonly eventsPath: string;
  private readonly drafts = new Map<string, PairPromptDraft>();

  constructor(dataDir: string) {
    this.eventsPath = join(dataDir, 'pair-prompts', 'drafts.jsonl');
    mkdirSync(dirname(this.eventsPath), { recursive: true });
    this.load();
    this.failInterruptedSends();
  }

  listForSession(sessionId: string): PairPromptDraft[] {
    return [...this.drafts.values()]
      .filter(draft => draft.diwanSessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(draftId: string): PairPromptDraft | undefined {
    return this.drafts.get(draftId);
  }

  create(input: {
    session: CodeSession;
    channelId: string;
    actor: AuthenticatedUser;
    initialText?: string;
  }): PairPromptDraft {
    const text = normalizePromptText(input.initialText ?? '');
    const now = new Date().toISOString();
    const draft: PairPromptDraft = {
      id: `pair-${nanoid(12)}`,
      channelId: input.channelId,
      diwanSessionId: input.session.id,
      opencodeSessionId: input.session.openCodeSessionId,
      createdAt: now,
      createdByEmail: input.actor.email,
      createdByLinuxUser: input.actor.linuxUser,
      status: 'editing',
      draftText: text,
      retryCount: 0,
    };
    this.record({ type: 'created', draft });
    return draft;
  }

  updateText(
    draftId: string,
    actor: AuthenticatedUser,
    text: string,
  ): PairPromptDraft {
    const draft = this.requireDraft(draftId);
    if (draft.status !== 'editing') {
      throw new Error('Pair prompt is not editable');
    }
    const normalized = normalizePromptText(text);
    this.record({
      type: 'textUpdated',
      draftId,
      updatedByEmail: actor.email,
      updatedAt: new Date().toISOString(),
      text: normalized,
    });
    return this.requireDraft(draftId);
  }

  markReady(draftId: string, actor: AuthenticatedUser): PairPromptDraft {
    const draft = this.requireDraft(draftId);
    if (draft.status !== 'editing') {
      throw new Error('Pair prompt must be editing before it can be ready');
    }
    const snapshotText = draft.draftText.trim();
    if (!snapshotText) {
      throw new Error('Pair prompt text is required');
    }
    this.record({
      type: 'ready',
      draftId,
      readyByEmail: actor.email,
      readyAt: new Date().toISOString(),
      snapshotText,
      snapshotHash: hashPrompt(snapshotText),
    });
    return this.requireDraft(draftId);
  }

  reopen(
    draftId: string,
    actor: AuthenticatedUser,
    reason?: string,
  ): PairPromptDraft {
    const draft = this.requireDraft(draftId);
    if (!['ready', 'rejected', 'failed'].includes(draft.status)) {
      throw new Error('Pair prompt cannot be reopened from its current status');
    }
    this.record({
      type: 'reopened',
      draftId,
      reopenedByEmail: actor.email,
      reopenedAt: new Date().toISOString(),
      reason: reason?.trim() || undefined,
    });
    return this.requireDraft(draftId);
  }

  reject(
    draftId: string,
    actor: AuthenticatedUser,
    reason?: string,
  ): PairPromptDraft {
    const draft = this.requireDraft(draftId);
    this.assertReviewerAllowed(draft, actor, 'ready');
    this.record({
      type: 'rejected',
      draftId,
      reviewedByEmail: actor.email,
      reviewedAt: new Date().toISOString(),
      reason: reason?.trim() || undefined,
    });
    return this.requireDraft(draftId);
  }

  startSending(draftId: string, actor: AuthenticatedUser): PairPromptDraft {
    const draft = this.requireDraft(draftId);
    this.assertReviewerAllowed(draft, actor, 'ready', 'failed');
    if (!draft.reviewSnapshotText) {
      throw new Error('Pair prompt has no frozen review snapshot');
    }
    this.record({
      type: 'sending',
      draftId,
      sendingStartedAt: new Date().toISOString(),
    });
    return this.requireDraft(draftId);
  }

  markSent(
    draftId: string,
    actor: AuthenticatedUser,
    openCodeMessageId?: string,
  ): PairPromptDraft {
    this.record({
      type: 'sent',
      draftId,
      sentAt: new Date().toISOString(),
      reviewedByEmail: actor.email,
      openCodeMessageId,
    });
    return this.requireDraft(draftId);
  }

  markFailed(
    draftId: string,
    input: {
      actor?: AuthenticatedUser;
      failureCode: string;
      failureMessage: string;
    },
  ): PairPromptDraft {
    this.record({
      type: 'failed',
      draftId,
      failedAt: new Date().toISOString(),
      reviewedByEmail: input.actor?.email,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
    });
    return this.requireDraft(draftId);
  }

  private assertReviewerAllowed(
    draft: PairPromptDraft,
    actor: AuthenticatedUser,
    ...statuses: PairPromptStatus[]
  ): void {
    if (!statuses.includes(draft.status)) {
      throw new Error('Pair prompt is not ready for this review action');
    }
    if (draft.readyByEmail === actor.email) {
      throw new Error('The requester cannot approve or reject this snapshot');
    }
  }

  private record(event: PairPromptEvent): void {
    this.apply(event);
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
    });
  }

  private load(): void {
    if (!existsSync(this.eventsPath)) {
      return;
    }
    const raw = readFileSync(this.eventsPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      this.apply(JSON.parse(line) as PairPromptEvent);
    }
  }

  private apply(event: PairPromptEvent): void {
    if (event.type === 'created') {
      this.drafts.set(event.draft.id, { ...event.draft });
      return;
    }
    const draft = this.requireDraft(event.draftId);
    switch (event.type) {
      case 'textUpdated':
        draft.draftText = event.text;
        break;
      case 'ready':
        draft.status = 'ready';
        draft.readyByEmail = event.readyByEmail;
        draft.readyAt = event.readyAt;
        draft.reviewSnapshotText = event.snapshotText;
        draft.reviewSnapshotHash = event.snapshotHash;
        draft.rejectedReason = undefined;
        draft.failedAt = undefined;
        draft.failureCode = undefined;
        draft.failureMessage = undefined;
        break;
      case 'reopened':
        draft.status = 'editing';
        break;
      case 'rejected':
        draft.status = 'rejected';
        draft.reviewedByEmail = event.reviewedByEmail;
        draft.reviewedAt = event.reviewedAt;
        draft.rejectedReason = event.reason;
        break;
      case 'sending':
        draft.status = 'sending';
        draft.sendingStartedAt = event.sendingStartedAt;
        if (draft.failedAt) {
          draft.retryCount += 1;
        }
        break;
      case 'sent':
        draft.status = 'sent';
        draft.reviewedByEmail = event.reviewedByEmail;
        draft.sentAt = event.sentAt;
        draft.openCodeMessageId = event.openCodeMessageId;
        break;
      case 'failed':
        draft.status = 'failed';
        draft.reviewedByEmail = event.reviewedByEmail ?? draft.reviewedByEmail;
        draft.failedAt = event.failedAt;
        draft.failureCode = event.failureCode;
        draft.failureMessage = event.failureMessage;
        break;
    }
  }

  private failInterruptedSends(): void {
    const interrupted = [...this.drafts.values()].filter(
      draft => draft.status === 'sending',
    );
    for (const draft of interrupted) {
      this.record({
        type: 'failed',
        draftId: draft.id,
        failedAt: new Date().toISOString(),
        failureCode: 'interrupted',
        failureMessage: 'OpenCortex restarted while this prompt was sending.',
      });
    }
  }

  private requireDraft(draftId: string): PairPromptDraft {
    const draft = this.drafts.get(draftId);
    if (!draft) {
      throw new Error('Pair prompt not found');
    }
    return draft;
  }
}

function normalizePromptText(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxPromptBytes) {
    throw new Error('Pair prompt exceeds 64 KiB');
  }
  return text;
}

function hashPrompt(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}
