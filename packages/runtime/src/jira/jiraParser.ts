export interface ParsedJiraReference {
  key: string;
  url?: string;
}

export interface ParsedTeamReference {
  teamName: string;
}

const jiraKeyPattern = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

export function parseJiraReferences(input: string): ParsedJiraReference[] {
  const references = new Map<string, ParsedJiraReference>();
  for (const match of input.matchAll(jiraKeyPattern)) {
    const key = match[1].toUpperCase();
    references.set(key, {
      key,
      url: findUrlForKey(input, key),
    });
  }
  return [...references.values()];
}

export function parseTeamReferences(input: string): ParsedTeamReference[] {
  const references = new Map<string, ParsedTeamReference>();
  for (const match of input.matchAll(
    /(?:^|\s)(?:team|jira-team):([^\n,;]+)/gi,
  )) {
    const teamName = normalizeTeamName(match[1]);
    if (teamName) {
      references.set(teamName.toLowerCase(), { teamName });
    }
  }
  return [...references.values()];
}

export function normalizeJiraKey(input: string): string | undefined {
  const match = input.match(jiraKeyPattern);
  return match?.[0]?.toUpperCase();
}

function findUrlForKey(input: string, key: string): string | undefined {
  const urlPattern = /https?:\/\/[^\s)>"']+/g;
  for (const match of input.matchAll(urlPattern)) {
    const url = match[0];
    if (url.toUpperCase().includes(key)) {
      return url;
    }
  }
  return undefined;
}

function normalizeTeamName(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}
