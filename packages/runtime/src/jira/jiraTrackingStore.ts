import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { AuthenticatedUser } from '../auth/types.js';
import type { ChatChannel } from '../chat/chatStore.js';
import type { CodeSession } from '../code/sessionLauncher.js';
import { parseJiraReferences, parseTeamReferences } from './jiraParser.js';

export type JiraSessionLinkKind = 'issue' | 'team';
export type JiraSessionLinkSource =
  | 'manual'
  | 'chat-message'
  | 'pair-prompt'
  | 'session-launch'
  | 'git-branch'
  | 'git-commit'
  | 'pull-request'
  | 'jira-enrichment';
export type JiraSessionLinkConfidence = 'explicit' | 'inferred' | 'manual';

export interface JiraSessionLink {
  id: string;
  kind: JiraSessionLinkKind;
  sessionId: string;
  channelId: string;
  createdAt: string;
  createdByEmail: string;
  source: JiraSessionLinkSource;
  confidence: JiraSessionLinkConfidence;
  targetKey?: string;
  targetUrl?: string;
  teamId?: string;
  teamName?: string;
  evidenceText: string;
  evidenceRef?: {
    type: JiraSessionLinkSource;
    id?: string;
    url?: string;
    path?: string;
    sha?: string;
  };
  removedAt?: string;
  removedByEmail?: string;
}

export interface JiraItemCacheEntry {
  key: string;
  url?: string;
  summary?: string;
  status?: string;
  assigneeEmail?: string;
  projectKey?: string;
  teamId?: string;
  teamName?: string;
  updatedAt?: string;
  fetchedAt: string;
}

export interface JiraTeamCacheEntry {
  id: string;
  name: string;
  source: 'jira-team-field' | 'atlassian-team' | 'manual';
  memberEmails?: string[];
  fetchedAt?: string;
}

export interface CreateJiraSessionLinkInput {
  session: CodeSession;
  channel: ChatChannel;
  actor: AuthenticatedUser;
  source: JiraSessionLinkSource;
  confidence: JiraSessionLinkConfidence;
  kind: JiraSessionLinkKind;
  targetKey?: string;
  targetUrl?: string;
  teamId?: string;
  teamName?: string;
  evidenceText: string;
  evidenceRef?: JiraSessionLink['evidenceRef'];
}

export interface SearchSessionsInput {
  jiraKey?: string;
  teamId?: string;
  teamName?: string;
  projectKey?: string;
  ownerEmail?: string;
  memberEmail?: string;
  workspaceDir?: string;
  source?: JiraSessionLinkSource;
  confidence?: JiraSessionLinkConfidence;
  createdAfter?: string;
  createdBefore?: string;
  includeArchived?: boolean;
  includeUntagged?: boolean;
}

export interface JiraItemSearchResult {
  key: string;
  item?: JiraItemCacheEntry;
  links: JiraSessionLink[];
  sessionIds: string[];
}

export interface JiraItemDetail {
  key: string;
  item: JiraItemCacheEntry;
  links: JiraSessionLink[];
  sessionIds: string[];
  firstSeenAt?: string;
  lastSeenAt?: string;
  sourceCounts: Partial<Record<JiraSessionLinkSource, number>>;
  integrationFormat: {
    descriptionSection: string;
  };
}

export interface JiraTeamSearchResult {
  id?: string;
  name: string;
  team?: JiraTeamCacheEntry;
  links: JiraSessionLink[];
  sessionIds: string[];
}

type JiraTrackingEvent =
  | { type: 'created'; link: JiraSessionLink }
  | {
      type: 'removed';
      id: string;
      removedAt: string;
      removedByEmail: string;
    };

export class JiraTrackingStore {
  private readonly linksPath: string;
  private readonly issueCachePath: string;
  private readonly teamCachePath: string;
  private readonly links = new Map<string, JiraSessionLink>();
  private readonly issueCache = new Map<string, JiraItemCacheEntry>();
  private readonly teamCache = new Map<string, JiraTeamCacheEntry>();

  constructor(dataDir: string) {
    const dir = join(dataDir, 'jira-tracking');
    this.linksPath = join(dir, 'links.jsonl');
    this.issueCachePath = join(dir, 'issue-cache.json');
    this.teamCachePath = join(dir, 'team-cache.json');
    mkdirSync(dir, { recursive: true });
    this.loadLinks();
    this.loadIssueCache();
    this.loadTeamCache();
  }

  listForSession(sessionId: string): JiraSessionLink[] {
    return this.activeLinks()
      .filter(link => link.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  create(input: CreateJiraSessionLinkInput): JiraSessionLink {
    const existing = this.findActiveDuplicate(input);
    if (existing) {
      return existing;
    }
    const link: JiraSessionLink = {
      id: nanoid(12),
      kind: input.kind,
      sessionId: input.session.id,
      channelId: input.channel.id,
      createdAt: new Date().toISOString(),
      createdByEmail: input.actor.email,
      source: input.source,
      confidence: input.confidence,
      ...(input.targetKey ? { targetKey: input.targetKey.toUpperCase() } : {}),
      ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.teamName ? { teamName: input.teamName } : {}),
      evidenceText: input.evidenceText,
      ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
    };
    this.links.set(link.id, link);
    this.appendEvent({ type: 'created', link });
    this.updateCachesForLink(link);
    return link;
  }

  createFromText(input: {
    session: CodeSession;
    channel: ChatChannel;
    actor: AuthenticatedUser;
    source: JiraSessionLinkSource;
    confidence: JiraSessionLinkConfidence;
    evidenceText: string;
    evidenceRef?: JiraSessionLink['evidenceRef'];
  }): JiraSessionLink[] {
    const created: JiraSessionLink[] = [];
    for (const reference of parseJiraReferences(input.evidenceText)) {
      created.push(
        this.create({
          ...input,
          kind: 'issue',
          targetKey: reference.key,
          targetUrl: reference.url,
        }),
      );
    }
    for (const reference of parseTeamReferences(input.evidenceText)) {
      created.push(
        this.create({
          ...input,
          kind: 'team',
          teamName: reference.teamName,
        }),
      );
    }
    return created;
  }

  remove(
    linkId: string,
    actor: AuthenticatedUser,
  ): JiraSessionLink | undefined {
    const existing = this.links.get(linkId);
    if (!existing || existing.removedAt) {
      return undefined;
    }
    const removed: JiraSessionLink = {
      ...existing,
      removedAt: new Date().toISOString(),
      removedByEmail: actor.email,
    };
    this.links.set(linkId, removed);
    this.appendEvent({
      type: 'removed',
      id: linkId,
      removedAt: removed.removedAt!,
      removedByEmail: actor.email,
    });
    return removed;
  }

  searchSessions(
    sessions: CodeSession[],
    channelForSession: (session: CodeSession) => ChatChannel | undefined,
    input: SearchSessionsInput,
  ): Array<{
    session: CodeSession;
    channel?: ChatChannel;
    jiraLinks: JiraSessionLink[];
    jiraItems: JiraItemCacheEntry[];
    teams: JiraTeamCacheEntry[];
  }> {
    const includeArchived = input.includeArchived ?? true;
    return sessions
      .map(session => {
        const channel = channelForSession(session);
        const jiraLinks = this.listForSession(session.id);
        const jiraItems = this.itemsForLinks(jiraLinks);
        const teams = this.teamsForLinks(jiraLinks);
        return {
          session,
          channel,
          jiraLinks,
          jiraItems,
          teams,
        };
      })
      .filter(item => includeArchived || !item.channel?.archivedAt)
      .filter(item => matchesSessionFilters(item, input))
      .sort((a, b) => b.session.createdAt.localeCompare(a.session.createdAt));
  }

  searchJiraItems(input: {
    sessionId?: string;
    teamId?: string;
    teamName?: string;
    projectKey?: string;
    createdAfter?: string;
    createdBefore?: string;
  }): JiraItemSearchResult[] {
    const grouped = new Map<string, JiraSessionLink[]>();
    for (const link of this.activeLinks()) {
      if (link.kind !== 'issue' || !link.targetKey) {
        continue;
      }
      if (!matchesLinkWindow(link, input)) {
        continue;
      }
      const item = this.issueCache.get(link.targetKey);
      if (input.sessionId && link.sessionId !== input.sessionId) {
        continue;
      }
      if (input.projectKey && projectKeyFor(link, item) !== input.projectKey) {
        continue;
      }
      if (
        input.teamId &&
        item?.teamId !== input.teamId &&
        !this.hasTeamLinkForSession(link.sessionId, { teamId: input.teamId })
      ) {
        continue;
      }
      if (
        input.teamName &&
        !sameName(item?.teamName, input.teamName) &&
        !this.hasTeamLinkForSession(link.sessionId, {
          teamName: input.teamName,
        })
      ) {
        continue;
      }
      grouped.set(link.targetKey, [
        ...(grouped.get(link.targetKey) ?? []),
        link,
      ]);
    }
    return [...grouped.entries()]
      .map(([key, links]) => ({
        key,
        item: this.issueCache.get(key),
        links,
        sessionIds: unique(links.map(link => link.sessionId)),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  getJiraItemDetail(key: string): JiraItemDetail | undefined {
    const normalizedKey = key.toUpperCase();
    const links = this.activeLinks()
      .filter(link => link.kind === 'issue' && link.targetKey === normalizedKey)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (links.length === 0) {
      return undefined;
    }
    const item = this.issueCache.get(normalizedKey) ?? {
      key: normalizedKey,
      projectKey: normalizedKey.split('-')[0],
      fetchedAt: '',
    };
    const sourceCounts: Partial<Record<JiraSessionLinkSource, number>> = {};
    for (const link of links) {
      sourceCounts[link.source] = (sourceCounts[link.source] ?? 0) + 1;
    }
    return {
      key: normalizedKey,
      item,
      links,
      sessionIds: unique(links.map(link => link.sessionId)),
      firstSeenAt: links[0]?.createdAt,
      lastSeenAt: links.at(-1)?.createdAt,
      sourceCounts,
      integrationFormat: {
        descriptionSection: jiraItemIntegrationDescription(normalizedKey),
      },
    };
  }

  searchTeams(input: {
    sessionId?: string;
    jiraKey?: string;
    projectKey?: string;
    memberEmail?: string;
    createdAfter?: string;
    createdBefore?: string;
  }): JiraTeamSearchResult[] {
    const grouped = new Map<string, JiraSessionLink[]>();
    for (const link of this.activeLinks()) {
      if (link.kind === 'issue' && link.targetKey) {
        const item = this.issueCache.get(link.targetKey);
        if (!item?.teamId && !item?.teamName) {
          continue;
        }
        if (!matchesLinkWindow(link, input)) {
          continue;
        }
        if (input.sessionId && link.sessionId !== input.sessionId) {
          continue;
        }
        if (input.jiraKey && link.targetKey !== input.jiraKey.toUpperCase()) {
          continue;
        }
        if (
          input.projectKey &&
          projectKeyFor(link, item) !== input.projectKey
        ) {
          continue;
        }
        const team = item.teamId ? this.teamCache.get(item.teamId) : undefined;
        if (
          input.memberEmail &&
          !team?.memberEmails?.includes(input.memberEmail)
        ) {
          continue;
        }
        const key = item.teamId ?? item.teamName!.toLowerCase();
        grouped.set(key, [...(grouped.get(key) ?? []), link]);
        continue;
      }
      if (link.kind !== 'team') {
        continue;
      }
      if (!matchesLinkWindow(link, input)) {
        continue;
      }
      if (input.sessionId && link.sessionId !== input.sessionId) {
        continue;
      }
      if (
        input.jiraKey &&
        !this.hasIssueLinkForSession(link.sessionId, input.jiraKey)
      ) {
        continue;
      }
      if (
        input.projectKey &&
        !this.hasProjectLinkForSession(link.sessionId, input.projectKey)
      ) {
        continue;
      }
      const team = link.teamId ? this.teamCache.get(link.teamId) : undefined;
      if (
        input.memberEmail &&
        !team?.memberEmails?.includes(input.memberEmail)
      ) {
        continue;
      }
      const key = link.teamId ?? link.teamName?.toLowerCase() ?? link.id;
      grouped.set(key, [...(grouped.get(key) ?? []), link]);
    }
    return [...grouped.values()]
      .map(links => {
        const first = links[0];
        const issueTeam =
          first.kind === 'issue' && first.targetKey
            ? this.issueCache.get(first.targetKey)
            : undefined;
        const teamId = first.teamId ?? issueTeam?.teamId;
        const teamName = first.teamName ?? issueTeam?.teamName;
        const team = teamId ? this.teamCache.get(teamId) : undefined;
        return {
          id: teamId,
          name: team?.name ?? teamName ?? 'Unknown team',
          team,
          links,
          sessionIds: unique(links.map(link => link.sessionId)),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private activeLinks(): JiraSessionLink[] {
    return [...this.links.values()].filter(link => !link.removedAt);
  }

  private findActiveDuplicate(
    input: CreateJiraSessionLinkInput,
  ): JiraSessionLink | undefined {
    const targetKey = input.targetKey?.toUpperCase();
    return this.activeLinks().find(
      link =>
        link.sessionId === input.session.id &&
        link.kind === input.kind &&
        link.source === input.source &&
        link.evidenceRef?.id === input.evidenceRef?.id &&
        (input.kind === 'issue'
          ? link.targetKey === targetKey
          : (input.teamId && link.teamId === input.teamId) ||
            (input.teamName && sameName(link.teamName, input.teamName))),
    );
  }

  private itemsForLinks(links: JiraSessionLink[]): JiraItemCacheEntry[] {
    return unique(
      links
        .filter(link => link.kind === 'issue' && link.targetKey)
        .map(link => link.targetKey!),
    ).map(
      key =>
        this.issueCache.get(key) ?? {
          key,
          projectKey: key.split('-')[0],
          fetchedAt: '',
        },
    );
  }

  private teamsForLinks(links: JiraSessionLink[]): JiraTeamCacheEntry[] {
    const teams = new Map<string, JiraTeamCacheEntry>();
    for (const link of links) {
      if (link.kind === 'team') {
        const key = link.teamId ?? link.teamName?.toLowerCase() ?? link.id;
        teams.set(
          key,
          (link.teamId ? this.teamCache.get(link.teamId) : undefined) ?? {
            id: key,
            name: link.teamName ?? 'Unknown team',
            source: 'manual',
          },
        );
      }
      if (link.kind === 'issue' && link.targetKey) {
        const item = this.issueCache.get(link.targetKey);
        if (item?.teamId || item?.teamName) {
          const key = item.teamId ?? item.teamName!.toLowerCase();
          teams.set(
            key,
            (item.teamId ? this.teamCache.get(item.teamId) : undefined) ?? {
              id: key,
              name: item.teamName ?? key,
              source: 'jira-team-field',
            },
          );
        }
      }
    }
    return [...teams.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private updateCachesForLink(link: JiraSessionLink): void {
    if (link.kind === 'issue' && link.targetKey) {
      this.issueCache.set(link.targetKey, {
        ...(this.issueCache.get(link.targetKey) ?? {}),
        key: link.targetKey,
        url: link.targetUrl ?? this.issueCache.get(link.targetKey)?.url,
        projectKey: link.targetKey.split('-')[0],
        fetchedAt: this.issueCache.get(link.targetKey)?.fetchedAt ?? '',
      });
      this.persistJson(this.issueCachePath, [...this.issueCache.values()]);
    }
    if (link.kind === 'team') {
      const id = link.teamId ?? link.teamName?.toLowerCase();
      if (id) {
        this.teamCache.set(id, {
          ...(this.teamCache.get(id) ?? {}),
          id,
          name: link.teamName ?? this.teamCache.get(id)?.name ?? id,
          source: this.teamCache.get(id)?.source ?? 'manual',
        });
        this.persistJson(this.teamCachePath, [...this.teamCache.values()]);
      }
    }
  }

  private hasTeamLinkForSession(
    sessionId: string,
    target: { teamId?: string; teamName?: string },
  ): boolean {
    return this.activeLinks().some(
      link =>
        link.sessionId === sessionId &&
        link.kind === 'team' &&
        ((target.teamId && link.teamId === target.teamId) ||
          (target.teamName && sameName(link.teamName, target.teamName))),
    );
  }

  private hasIssueLinkForSession(sessionId: string, jiraKey: string): boolean {
    return this.activeLinks().some(
      link =>
        link.sessionId === sessionId &&
        link.kind === 'issue' &&
        link.targetKey === jiraKey.toUpperCase(),
    );
  }

  private hasProjectLinkForSession(
    sessionId: string,
    projectKey: string,
  ): boolean {
    return this.activeLinks().some(link => {
      if (link.sessionId !== sessionId || link.kind !== 'issue') {
        return false;
      }
      return (
        projectKeyFor(link, this.issueCache.get(link.targetKey ?? '')) ===
        projectKey
      );
    });
  }

  private appendEvent(event: JiraTrackingEvent): void {
    mkdirSync(dirname(this.linksPath), { recursive: true });
    appendFileSync(this.linksPath, `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
    });
  }

  private loadLinks(): void {
    if (!existsSync(this.linksPath)) {
      return;
    }
    const raw = readFileSync(this.linksPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const event = JSON.parse(line) as JiraTrackingEvent;
      if (event.type === 'created') {
        this.links.set(event.link.id, event.link);
      } else {
        const existing = this.links.get(event.id);
        if (existing) {
          this.links.set(event.id, {
            ...existing,
            removedAt: event.removedAt,
            removedByEmail: event.removedByEmail,
          });
        }
      }
    }
  }

  private loadIssueCache(): void {
    for (const item of this.readJsonArray<JiraItemCacheEntry>(
      this.issueCachePath,
    )) {
      this.issueCache.set(item.key, item);
    }
  }

  private loadTeamCache(): void {
    for (const team of this.readJsonArray<JiraTeamCacheEntry>(
      this.teamCachePath,
    )) {
      this.teamCache.set(team.id, team);
    }
  }

  private readJsonArray<T>(path: string): T[] {
    if (!existsSync(path)) {
      return [];
    }
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }

  private persistJson(path: string, payload: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
    });
    renameSync(tmpPath, path);
  }
}

function matchesSessionFilters(
  item: {
    session: CodeSession;
    channel?: ChatChannel;
    jiraLinks: JiraSessionLink[];
    jiraItems: JiraItemCacheEntry[];
    teams: JiraTeamCacheEntry[];
  },
  input: SearchSessionsInput,
): boolean {
  if (input.ownerEmail && item.session.ownerEmail !== input.ownerEmail) {
    return false;
  }
  if (
    input.memberEmail &&
    !item.channel?.members.some(member => member.email === input.memberEmail)
  ) {
    return false;
  }
  if (
    input.workspaceDir &&
    !item.session.workspaceDir.startsWith(input.workspaceDir)
  ) {
    return false;
  }
  if (input.includeUntagged && !hasLinkScopedFilter(input)) {
    return true;
  }
  if (
    input.teamId &&
    !item.teams.some(team => team.id === input.teamId) &&
    !item.jiraLinks.some(link => link.teamId === input.teamId)
  ) {
    return false;
  }
  if (
    input.teamName &&
    !item.teams.some(team => sameName(team.name, input.teamName)) &&
    !item.jiraLinks.some(link => sameName(link.teamName, input.teamName))
  ) {
    return false;
  }
  return item.jiraLinks.some(link => matchesLinkFilter(link, input));
}

function hasLinkScopedFilter(input: SearchSessionsInput): boolean {
  return Boolean(
    input.jiraKey ||
    input.teamId ||
    input.teamName ||
    input.projectKey ||
    input.source ||
    input.confidence ||
    input.createdAfter ||
    input.createdBefore,
  );
}

function matchesLinkFilter(
  link: JiraSessionLink,
  input: SearchSessionsInput,
): boolean {
  if (!matchesLinkWindow(link, input)) {
    return false;
  }
  if (input.source && link.source !== input.source) {
    return false;
  }
  if (input.confidence && link.confidence !== input.confidence) {
    return false;
  }
  if (input.jiraKey && link.targetKey !== input.jiraKey.toUpperCase()) {
    return false;
  }
  if (input.teamId && link.kind === 'team' && link.teamId !== input.teamId) {
    return false;
  }
  if (
    input.teamName &&
    link.kind === 'team' &&
    !sameName(link.teamName, input.teamName)
  ) {
    return false;
  }
  if (
    input.projectKey &&
    (!link.targetKey || link.targetKey.split('-')[0] !== input.projectKey)
  ) {
    return false;
  }
  return true;
}

function matchesLinkWindow(
  link: JiraSessionLink,
  input: { createdAfter?: string; createdBefore?: string },
): boolean {
  if (input.createdAfter && link.createdAt < input.createdAfter) {
    return false;
  }
  if (input.createdBefore && link.createdAt > input.createdBefore) {
    return false;
  }
  return true;
}

function projectKeyFor(
  link: JiraSessionLink,
  item: JiraItemCacheEntry | undefined,
): string | undefined {
  return item?.projectKey ?? link.targetKey?.split('-')[0];
}

function sameName(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function jiraItemIntegrationDescription(key: string): string {
  return [
    '## OpenCortex Integration',
    `Jira Key: ${key}`,
    'Workspace Sessions: tracked automatically when this key appears in an OpenCortex session thread, pair prompt, branch, commit, or manual tag.',
    'Implementation Notes:',
    '- Keep acceptance criteria and QA notes under stable headings.',
    '- Mention related Jira keys explicitly so OpenCortex can correlate linked work.',
  ].join('\n');
}
