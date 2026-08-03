const tokenKey = 'opencortex.idToken';
const accessTokenKey = 'opencortex.accessToken';
const legacyTokenKey = 'diwan.idToken';
const legacyAccessTokenKey = 'diwan.accessToken';
const pkceKey = 'opencortex.pkce';
const legacyPkceKey = 'diwan.pkce';
const returnToKey = 'opencortex.returnTo';
const legacyReturnToKey = 'diwan.returnTo';
const authCookieName = 'opencortex.idToken';
const legacyAuthCookieName = 'diwan.idToken';
const teamChatCollapsedKey = 'opencortex.teamchatCollapsed';
const legacyTeamChatCollapsedKey = 'diwan.teamchatCollapsed';
const channelLastSeenKey = 'opencortex.channelLastSeen';
const legacyChannelLastSeenKey = 'diwan.channelLastSeen';
const teamChatWidthKey = 'opencortex.teamchatWidthPx';
const legacyTeamChatWidthKey = 'diwan.teamchatWidthPx';

function currentBasePath() {
  const base = document.querySelector('base')?.getAttribute('href') ?? '/';
  const url = new URL(base, window.location.origin);
  return url.pathname.replace(/\/$/, '');
}

function bindUiAction(selector, event, handler) {
  const element = document.querySelector(selector);
  if (element) {
    element.addEventListener(event, handler);
  }
  return element;
}

function localStorageValue(key, legacyKey) {
  const value = localStorage.getItem(key);
  if (value !== null) {
    return value;
  }
  const legacyValue = localStorage.getItem(legacyKey);
  if (legacyValue !== null) {
    localStorage.setItem(key, legacyValue);
    localStorage.removeItem(legacyKey);
  }
  return legacyValue;
}

function setLocalStorageValue(key, legacyKey, value) {
  localStorage.setItem(key, value);
  localStorage.removeItem(legacyKey);
}

function apiUrl(path) {
  return currentBasePath() + '/api' + path;
}

function authCookiePath() {
  return currentBasePath() || '/';
}

function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(value);
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function syncAuthCookie() {
  const token = sessionStorage.getItem(tokenKey) ?? sessionStorage.getItem(legacyTokenKey);
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${legacyAuthCookieName}=; Path=${authCookiePath()}; SameSite=Strict; Max-Age=0${secure}`;
  if (!token) {
    document.cookie = `${authCookieName}=; Path=${authCookiePath()}; SameSite=Strict; Max-Age=0${secure}`;
    return;
  }
  document.cookie = `${authCookieName}=${encodeURIComponent(token)}; Path=${authCookiePath()}; SameSite=Strict${secure}`;
}

function randomString(length = 64) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256base64url(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

async function authConfig() {
  const response = await fetch(apiUrl('/auth/config'));
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function hasStoredToken() {
  return Boolean(sessionStorage.getItem(tokenKey) ?? sessionStorage.getItem(legacyTokenKey));
}

async function login() {
  const config = await authConfig();
  const verifier = randomString(48);
  sessionStorage.setItem(pkceKey, verifier);
  sessionStorage.removeItem(legacyPkceKey);
  const challenge = await sha256base64url(verifier);
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: config.scope,
    redirect_uri: config.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  if (config.identityProvider) {
    params.set('identity_provider', config.identityProvider);
  }
  window.location.assign(config.authorizationEndpoint + '?' + params.toString());
}

async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return;

  const verifier = sessionStorage.getItem(pkceKey) ?? sessionStorage.getItem(legacyPkceKey);
  if (!verifier) throw new Error('Missing PKCE verifier');

  const response = await fetch(apiUrl('/auth/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier: verifier }),
  });
  if (!response.ok) throw new Error(await response.text());
  const tokens = await response.json();
  sessionStorage.setItem(tokenKey, tokens.idToken);
  sessionStorage.removeItem(legacyTokenKey);
  if (tokens.accessToken) {
    sessionStorage.setItem(accessTokenKey, tokens.accessToken);
    sessionStorage.removeItem(legacyAccessTokenKey);
  }
  syncAuthCookie();
  sessionStorage.removeItem(pkceKey);
  sessionStorage.removeItem(legacyPkceKey);
  window.history.replaceState({}, document.title, authReturnPath());
}

function authReturnPath() {
  const saved = sessionStorage.getItem(returnToKey) ?? sessionStorage.getItem(legacyReturnToKey);
  sessionStorage.removeItem(returnToKey);
  sessionStorage.removeItem(legacyReturnToKey);
  if (saved?.startsWith(currentBasePath() + '/')) {
    return saved;
  }
  return currentBasePath() + '/';
}

function authHeaders() {
  syncAuthCookie();
  const token = sessionStorage.getItem(tokenKey) ?? sessionStorage.getItem(legacyTokenKey);
  if (!token) return { 'Content-Type': 'application/json' };
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token,
  };
}

async function api(path, options = {}) {
  const { redirectOnUnauthorized = true, ...fetchOptions } = options;
  const response = await fetch(apiUrl(path), {
    ...fetchOptions,
    headers: { ...authHeaders(), ...(fetchOptions.headers ?? {}) },
  });
  if (response.status === 401) {
    if (!redirectOnUnauthorized) {
      return undefined;
    }
    sessionStorage.setItem(returnToKey, window.location.pathname);
    sessionStorage.removeItem(legacyReturnToKey);
    await login();
    return undefined;
  }
  if (!response.ok) {
    const text = await response.text();
    try {
      const payload = JSON.parse(text);
      throw new Error(payload.message ?? payload.error ?? text);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(text);
      }
      throw error;
    }
  }
  return response.json();
}

let currentUser;
let currentView = window.location.pathname.endsWith('/profile')
  ? 'profile'
  : 'workspace';
let channels = [];
let sessions = [];
let pairPrompts = [];
let jiraLinks = [];
let workSearchResults = [];
let observabilitySummary;
let selectedChannelId = 'general';
let chatEvents;
let chatEventReconnectTimer;
let sessionNameRefreshTimer;
let renderedCodeFrameKey;
let teamChatCollapsed =
  localStorageValue(teamChatCollapsedKey, legacyTeamChatCollapsedKey) === 'true';
const channelLastSeen = JSON.parse(
  localStorageValue(channelLastSeenKey, legacyChannelLastSeenKey) ?? '{}',
);
const jiraKeyPattern = /\b([A-Z][A-Z0-9]+-\d+)\b/gi;

function setAuthenticated(user) {
  currentUser = user;
  if (!user) {
    observabilitySummary = undefined;
  }
  document.querySelector('#auth-screen').hidden = Boolean(user);
  document.querySelector('#workspace-grid').hidden =
    !user || currentView !== 'workspace';
  document.querySelector('#profile-page').hidden =
    !user || currentView !== 'profile';
  document.querySelector('#sign-in').hidden = Boolean(user);
  document.querySelector('#auth-screen-sign-in').hidden = Boolean(user);
  document.querySelector('#sign-out').hidden = !user;
  document.querySelector('#profile-link').hidden = !user;
  document.querySelector('#start-code').hidden = !user;
  document.querySelector('#auth-status').textContent = user
    ? user.name || user.email
    : 'Signed out';
  renderProfile();
  renderObservabilityPanel();
}

function showWorkspace() {
  currentView = 'workspace';
  window.history.pushState({}, document.title, currentBasePath() + '/');
  setAuthenticated(currentUser);
}

function showProfile() {
  currentView = 'profile';
  window.history.pushState({}, document.title, currentBasePath() + '/profile');
  setAuthenticated(currentUser);
}

function renderProfile() {
  if (!currentUser) return;
  document.querySelector('#profile-subtitle').textContent =
    currentUser.name || currentUser.email;
  const details = document.querySelector('#profile-details');
  details.innerHTML = '';
  const rows = [
    ['Email', currentUser.email],
    ['Display name', currentUser.name || 'Not provided'],
    ['Linux user', currentUser.linuxUser],
    ['Groups', (currentUser.groups ?? []).join(', ') || 'None'],
    ['Role', currentUser.isSuperAdmin ? 'Super admin' : 'User'],
  ];
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    details.append(term, description);
  }
}

async function logout() {
  chatEvents?.close();
  window.clearTimeout(chatEventReconnectTimer);
  window.clearInterval(sessionNameRefreshTimer);
  sessionStorage.removeItem(tokenKey);
  sessionStorage.removeItem(accessTokenKey);
  sessionStorage.removeItem(legacyTokenKey);
  sessionStorage.removeItem(legacyAccessTokenKey);
  sessionStorage.removeItem(pkceKey);
  sessionStorage.removeItem(legacyPkceKey);
  sessionStorage.removeItem(returnToKey);
  sessionStorage.removeItem(legacyReturnToKey);
  syncAuthCookie();
  setAuthenticated(undefined);
  const config = await authConfig().catch(() => undefined);
  if (config?.logoutUrl) {
    window.location.assign(config.logoutUrl);
  } else {
    window.history.replaceState({}, document.title, currentBasePath() + '/');
  }
}

function initialSessionIdFromPath() {
  const basePath = currentBasePath();
  const relativePath = window.location.pathname
    .slice(basePath.length)
    .replace(/^\/+/, '/');
  const match = relativePath.match(/^\/code\/sessions\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

const chatEventTypes = [
  'channel.created',
  'channel.updated',
  'message.created',
  'pairPrompt.created',
  'pairPrompt.ready',
  'pairPrompt.reopened',
  'pairPrompt.rejected',
  'pairPrompt.sending',
  'pairPrompt.sent',
  'pairPrompt.failed',
  'jiraLinks.updated',
  'session.started',
  'session.archived',
];

function selectedChannel() {
  return channels.find(channel => channel.id === selectedChannelId);
}

function selectedSession() {
  const channel = selectedChannel();
  if (!channel?.session) {
    return undefined;
  }

  const exact = sessions.find(item => item.channel?.id === channel.id);
  if (exact) {
    return sessionForChannelBinding(exact, channel);
  }

  const sessionId = channel.session.sessionId;
  const openCodeSessionId = channel.session.openCodeSessionId;
  const fallback = sessions.find(
    item =>
      item.id === sessionId &&
      (!openCodeSessionId || item.openCodeSessionId === openCodeSessionId),
  );
  if (fallback) {
    return sessionForChannelBinding(fallback, channel);
  }

  if (!sessionId || !channel.session.urlPath) {
    return undefined;
  }
  return {
    id: sessionId,
    urlPath: channel.session.urlPath,
    openCodeSessionId,
    workspaceDir: channel.session.workspaceDir,
    channel,
  };
}

function sessionForChannelBinding(session, channel) {
  const binding = channel.session;
  if (!binding) {
    return { ...session, channel };
  }
  return {
    ...session,
    channel,
    openCodeSessionId: binding.openCodeSessionId ?? session.openCodeSessionId,
    workspaceDir: binding.workspaceDir ?? session.workspaceDir,
    urlPath: binding.urlPath ?? session.urlPath,
  };
}

function channelSection(channel) {
  if (channel.id === 'general') return 'General';
  if (channel.archivedAt) return 'Archived';
  const owner = channel.members?.find(member => member.role === 'owner');
  if (owner?.email === currentUser?.email) return 'My sessions';
  return 'Shared with me';
}

function channelTitle(channel) {
  return channel.type === 'global' ? `#${channel.name}` : channel.name;
}

function formatRelativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';

  const diffMs = Math.abs(Date.now() - timestamp);
  if (diffMs < 60000) return 'now';

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function channelActivityTime(channel) {
  return formatRelativeTime(channel.lastMessageAt ?? channel.createdAt);
}

function channelSubtitle(channel) {
  if (channel.type === 'global') {
    return 'Team channel';
  }
  const owner = channel.members?.find(member => member.role === 'owner');
  const workspace = channel.session?.workspaceDir
    ?.split('/')
    .filter(Boolean)
    .pop();
  return [owner?.email, workspace].filter(Boolean).join(' · ');
}

function channelHasUnread(channel) {
  return Boolean(
    channel.lastMessageAt &&
    (teamChatCollapsed || channel.id !== selectedChannelId) &&
    channel.lastMessageAt > (channelLastSeen[channel.id] ?? ''),
  );
}

function totalUnreadCount() {
  return channels.filter(channelHasUnread).length;
}

function markSelectedChannelSeen() {
  const channel = selectedChannel();
  if (teamChatCollapsed) {
    return;
  }
  if (!channel?.lastMessageAt) {
    return;
  }
  channelLastSeen[channel.id] = channel.lastMessageAt;
  setLocalStorageValue(
    channelLastSeenKey,
    legacyChannelLastSeenKey,
    JSON.stringify(channelLastSeen),
  );
}

function renderTeamChatShell() {
  const grid = document.querySelector('#workspace-grid');
  const toggle = document.querySelector('#toggle-chat');
  const alert = document.querySelector('#teamchat-alert');
  const unread = totalUnreadCount();
  grid.classList.toggle('teamchat-collapsed', teamChatCollapsed);
  toggle.setAttribute('aria-expanded', String(!teamChatCollapsed));
  toggle.setAttribute(
    'aria-label',
    teamChatCollapsed ? 'Expand TeamChat' : 'Collapse TeamChat',
  );
  toggle.textContent = teamChatCollapsed ? '›' : '‹';
  alert.hidden = unread === 0;
  alert.textContent = String(unread);
}

function initPanelResizer() {
  const grid = document.querySelector('#workspace-grid');
  const resizer = document.querySelector('#pane-resizer');
  const chatPanel = document.querySelector('#chat-panel');
  if (!grid || !resizer || !chatPanel) return;

  const minWidth = 380;
  const maxWidth = 720;
  const clamp = value => Math.min(maxWidth, Math.max(minWidth, value));

  const applyWidth = width => {
    const next = clamp(width);
    grid.style.setProperty('--teamchat-width', `${next}px`);
    resizer.setAttribute('aria-valuenow', String(Math.round(next)));
  };

  const saved = Number(
    localStorageValue(teamChatWidthKey, legacyTeamChatWidthKey),
  );
  if (Number.isFinite(saved) && saved > 0) {
    applyWidth(saved);
  }

  resizer.setAttribute('aria-valuemin', String(minWidth));
  resizer.setAttribute('aria-valuemax', String(maxWidth));

  const widthFromClientX = clientX => {
    const rect = grid.getBoundingClientRect();
    return rect.right - clientX;
  };

  let dragging = false;

  const persistWidth = () => {
    const current = grid.style
      .getPropertyValue('--teamchat-width')
      .replace('px', '');
    if (current) {
      setLocalStorageValue(
        teamChatWidthKey,
        legacyTeamChatWidthKey,
        current.trim(),
      );
    }
  };

  const onPointerMove = event => {
    if (!dragging) return;
    applyWidth(widthFromClientX(event.clientX));
  };

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    persistWidth();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDragging);
  };

  resizer.addEventListener('pointerdown', event => {
    event.preventDefault();
    if (teamChatCollapsed) return;
    dragging = true;
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDragging);
  });

  resizer.addEventListener('keydown', event => {
    if (teamChatCollapsed) return;
    const step = event.shiftKey ? 40 : 16;
    const currentWidth = chatPanel.getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') {
      applyWidth(currentWidth + step);
    } else if (event.key === 'ArrowRight') {
      applyWidth(currentWidth - step);
    } else {
      return;
    }
    event.preventDefault();
    persistWidth();
  });
}

function renderChannels() {
  const target = document.querySelector('#channels');
  target.innerHTML = '';

  const label = document.createElement('label');
  label.className = 'session-picker-label';
  label.setAttribute('for', 'session-select');
  label.textContent = 'Session';

  const select = document.createElement('select');
  select.id = 'session-select';
  select.className = 'session-select';

  const sections = ['General', 'My sessions', 'Shared with me', 'Archived'];
  for (const section of sections) {
    const sectionChannels = channels.filter(
      channel => channelSection(channel) === section,
    );
    if (sectionChannels.length === 0) continue;

    const group = document.createElement('optgroup');
    group.label = section;
    for (const channel of sectionChannels) {
      const option = document.createElement('option');
      option.value = channel.id;
      option.textContent = sessionOptionLabel(channel);
      option.selected = channel.id === selectedChannelId;
      group.append(option);
    }
    select.append(group);
  }

  select.addEventListener('change', () => {
    selectedChannelId = select.value;
    if (teamChatCollapsed) {
      teamChatCollapsed = false;
      setLocalStorageValue(
        teamChatCollapsedKey,
        legacyTeamChatCollapsedKey,
        'false',
      );
    }
    renderTeamChatShell();
    void renderSelectedChannel();
  });

  target.append(label, select);
  renderTeamChatShell();
}

function sessionOptionLabel(channel) {
  const pieces = [channelTitle(channel)];
  const subtitle = channelSubtitle(channel);
  const activity = channelActivityTime(channel);
  if (subtitle) pieces.push(subtitle);
  if (activity) pieces.push(activity);
  if (channelHasUnread(channel)) pieces.push('unread');
  return pieces.join(' - ');
}

async function refreshChannels() {
  const data = await api('/chat/channels');
  if (!data) return;
  channels = data.channels;
  if (!channels.some(channel => channel.id === selectedChannelId)) {
    selectedChannelId = channels[0]?.id ?? 'general';
  }
  renderChannels();
}

async function refreshSessions() {
  const data = await api('/code/sessions');
  sessions = data && Array.isArray(data.sessions) ? data.sessions : [];
}

async function refreshObservabilitySummary() {
  try {
    const data = await api('/observability/summary', {
      redirectOnUnauthorized: false,
    });
    observabilitySummary = data?.summary;
  } catch (error) {
    observabilitySummary = {
      error: error.message,
    };
  }
  renderObservabilityPanel();
}

function selectInitialSessionChannel() {
  const sessionId = initialSessionIdFromPath();
  const session = sessionId
    ? sessions.find(item => item.id === sessionId)
    : sessions[0];
  if (session?.channel?.id) {
    selectedChannelId = session.channel.id;
  }
}

async function handleChatEvent(envelope) {
  if (
    envelope.type === 'channel.created' ||
    envelope.type === 'channel.updated' ||
    envelope.type === 'session.started' ||
    envelope.type === 'session.archived' ||
    envelope.type === 'jiraLinks.updated'
  ) {
    await refreshSessions();
    await refreshChannels();
    await renderSelectedChannel();
    return;
  }
  if (envelope.type === 'message.created') {
    await refreshChannels();
    if (envelope.channelId === selectedChannelId) {
      await refreshMessages();
      markSelectedChannelSeen();
      renderTeamChatShell();
    }
    renderChannels();
  }
  if (
    envelope.type?.startsWith('pairPrompt.') &&
    envelope.channelId === selectedChannelId
  ) {
    await refreshMessages();
    await refreshPairPrompts();
    renderPairPromptPanel();
  }
}

async function startChatEvents() {
  if (!window.EventSource) {
    await startChatEventFetchStream();
    return;
  }

  window.clearTimeout(chatEventReconnectTimer);
  chatEvents?.close();
  syncAuthCookie();
  chatEvents = new window.EventSource(apiUrl('/chat/events'));

  for (const eventType of chatEventTypes) {
    chatEvents.addEventListener(eventType, event => {
      void handleChatEvent(JSON.parse(event.data));
    });
  }

  chatEvents.onopen = () => {
    void refreshCurrentChannelState();
  };

  chatEvents.onerror = () => {
    chatEvents?.close();
    chatEventReconnectTimer = window.setTimeout(() => {
      void startChatEvents();
    }, 3000);
  };
}

async function startChatEventFetchStream() {
  try {
    const response = await fetch(apiUrl('/chat/events'), {
      headers: { ...authHeaders(), Accept: 'text/event-stream' },
    });
    if (response.status === 401) {
      await login();
      return;
    }
    if (!response.ok || !response.body) {
      scheduleChatEventFetchReconnect();
      return;
    }

    await refreshCurrentChannelState();
    await readChatEventStream(response.body);
  } catch {
    scheduleChatEventFetchReconnect();
  }
}

async function refreshCurrentChannelState() {
  await refreshSessions();
  await refreshChannels();
  await refreshObservabilitySummary();
  await refreshMessages();
  await refreshPairPrompts();
  renderPairPromptPanel();
}

function startSessionNameRefresh() {
  window.clearInterval(sessionNameRefreshTimer);
  sessionNameRefreshTimer = window.setInterval(async () => {
    await refreshSessions();
    await refreshChannels();
    await refreshObservabilitySummary();
    renderChannels();
    renderSelectedChannelHeader();
    renderWorkTrackingPanel();
  }, 10000);
}

function scheduleChatEventFetchReconnect() {
  window.clearTimeout(chatEventReconnectTimer);
  chatEventReconnectTimer = window.setTimeout(() => {
    void startChatEventFetchStream();
  }, 3000);
}

async function readChatEventStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const eventText of events) {
      const dataLine = eventText
        .split('\n')
        .find(line => line.startsWith('data: '));
      if (!dataLine) continue;
      await handleChatEvent(JSON.parse(dataLine.slice(6)));
    }
  }
  scheduleChatEventFetchReconnect();
}

function renderMessages(messages) {
  const target = document.querySelector('#messages');
  target.innerHTML = '';
  for (const message of messages) {
    const row = document.createElement('div');
    row.className = 'message';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      message.authorEmail +
      ' · ' +
      new Date(message.createdAt).toLocaleString();
    const body = document.createElement('div');
    body.className = 'message-body';
    appendTextWithJiraLinks(body, message.body);
    row.append(meta, body);
    target.append(row);
  }
  target.scrollTop = target.scrollHeight;
}

function appendTextWithJiraLinks(target, text) {
  let cursor = 0;
  jiraKeyPattern.lastIndex = 0;
  for (const match of text.matchAll(jiraKeyPattern)) {
    const key = match[1].toUpperCase();
    if (match.index > cursor) {
      target.append(document.createTextNode(text.slice(cursor, match.index)));
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jira-reference';
    button.textContent = key;
    button.title = 'Open Jira item details';
    button.addEventListener('click', () => void showJiraItemDetail(key));
    target.append(button);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    target.append(document.createTextNode(text.slice(cursor)));
  }
}

async function refreshMessages() {
  if (!selectedChannelId) {
    renderMessages([]);
    return;
  }
  const data = await api(
    `/chat/channels/${selectedChannelId}/messages?limit=all`,
  );
  if (data) renderMessages(data.messages);
}

async function refreshPairPrompts() {
  const session = selectedSession();
  if (!session) {
    pairPrompts = [];
    return;
  }
  const data = await api(`/code/sessions/${session.id}/pair-prompts`);
  pairPrompts = data && Array.isArray(data.drafts) ? data.drafts : [];
}

async function refreshJiraLinks() {
  const session = selectedSession();
  if (!session) {
    jiraLinks = [];
    return;
  }
  const data = await api(`/code/sessions/${session.id}/jira-links`);
  jiraLinks = data && Array.isArray(data.links) ? data.links : [];
}

function activePairPrompt() {
  return (
    pairPrompts.find(draft =>
      ['editing', 'ready', 'sending', 'failed'].includes(draft.status),
    ) ?? pairPrompts[0]
  );
}

function promptCanReview(draft) {
  return draft.readyByEmail && draft.readyByEmail !== currentUser?.email;
}

function renderPairPromptPanel() {
  const panel = document.querySelector('#pair-prompt-panel');
  const session = selectedSession();
  if (!session) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  panel.hidden = false;
  panel.innerHTML = '';

  const heading = document.createElement('div');
  heading.className = 'pair-prompt-heading';
  const title = document.createElement('h3');
  title.textContent = 'Pair Prompt';
  heading.append(title);

  const draft = activePairPrompt();
  if (!draft) {
    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.textContent = 'New draft';
    createButton.addEventListener('click', async () => {
      await api(`/code/sessions/${session.id}/pair-prompts`, {
        method: 'POST',
        body: JSON.stringify({ initialText: '' }),
      });
      await refreshPairPrompts();
      renderPairPromptPanel();
    });
    heading.append(createButton);
    panel.append(heading);
    return;
  }

  const status = document.createElement('span');
  status.className = 'pair-prompt-status';
  status.textContent = draft.status;
  heading.append(status);

  const body = document.createElement('div');
  body.className = 'pair-prompt-body';

  if (draft.status === 'editing') {
    const textarea = document.createElement('textarea');
    textarea.className = 'pair-prompt-editor';
    textarea.value = draft.draftText ?? '';
    textarea.placeholder = 'Compose the prompt for review';

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', async () => {
      await api(`/code/sessions/${session.id}/pair-prompts/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ text: textarea.value }),
      });
      await refreshPairPrompts();
      renderPairPromptPanel();
    });

    const ready = document.createElement('button');
    ready.type = 'button';
    ready.textContent = 'Ready for approval';
    ready.addEventListener('click', async () => {
      await api(`/code/sessions/${session.id}/pair-prompts/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ text: textarea.value }),
      });
      await api(`/code/sessions/${session.id}/pair-prompts/${draft.id}/ready`, {
        method: 'POST',
      });
      await refreshPairPrompts();
      await refreshMessages();
      renderPairPromptPanel();
    });

    const actions = document.createElement('div');
    actions.className = 'pair-prompt-actions';
    actions.append(save, ready);
    body.append(textarea, actions);
  } else {
    const snapshot = document.createElement('pre');
    snapshot.className = 'pair-prompt-snapshot';
    snapshot.textContent = draft.reviewSnapshotText ?? draft.draftText ?? '';
    body.append(snapshot);

    const meta = document.createElement('p');
    meta.className = 'pair-prompt-meta';
    meta.textContent = [
      draft.readyByEmail ? `Ready by ${draft.readyByEmail}` : undefined,
      draft.reviewedByEmail
        ? `Reviewed by ${draft.reviewedByEmail}`
        : undefined,
      draft.failureMessage,
    ]
      .filter(Boolean)
      .join(' · ');
    body.append(meta);

    const actions = document.createElement('div');
    actions.className = 'pair-prompt-actions';

    if (
      (draft.status === 'ready' || draft.status === 'failed') &&
      promptCanReview(draft)
    ) {
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.textContent =
        draft.status === 'failed' ? 'Retry send' : 'Approve';
      approve.addEventListener('click', async () => {
        await api(
          `/code/sessions/${session.id}/pair-prompts/${draft.id}/approve`,
          {
            method: 'POST',
          },
        ).catch(error => window.alert(error.message));
        await refreshPairPrompts();
        await refreshMessages();
        renderPairPromptPanel();
      });
      actions.append(approve);
    }

    if (draft.status === 'ready' && promptCanReview(draft)) {
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'secondary';
      reject.textContent = 'Reject';
      reject.addEventListener('click', async () => {
        const reason = window.prompt('Reason');
        await api(
          `/code/sessions/${session.id}/pair-prompts/${draft.id}/reject`,
          {
            method: 'POST',
            body: JSON.stringify({ reason: reason ?? undefined }),
          },
        );
        await refreshPairPrompts();
        await refreshMessages();
        renderPairPromptPanel();
      });
      actions.append(reject);
    }

    if (['ready', 'rejected', 'failed'].includes(draft.status)) {
      const reopen = document.createElement('button');
      reopen.type = 'button';
      reopen.className = 'secondary';
      reopen.textContent = 'Reopen';
      reopen.addEventListener('click', async () => {
        await api(
          `/code/sessions/${session.id}/pair-prompts/${draft.id}/reopen`,
          {
            method: 'POST',
            body: JSON.stringify({ reason: 'Reopened from TeamChat' }),
          },
        );
        await refreshPairPrompts();
        await refreshMessages();
        renderPairPromptPanel();
      });
      actions.append(reopen);
    }

    body.append(actions);
  }

  panel.append(heading, body);
}

document.querySelector('#chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.querySelector('#message');
  const body = input.value;
  input.value = '';
  await api(`/chat/channels/${selectedChannelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  await refreshChannels();
  await refreshMessages();
});

document.querySelector('#share-channel').addEventListener('click', async () => {
  const channel = selectedChannel();
  if (!channel) return;
  const email = window.prompt('Share this session with email');
  if (!email) return;
  await api(`/chat/channels/${channel.id}/share`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  await refreshChannels();
  await renderSelectedChannel();
});

document
  .querySelector('#open-selected-code')
  .addEventListener('click', async event => {
    const button = event.currentTarget;
    const session = selectedSession();
    if (!session) return;
    button.disabled = true;
    button.textContent = 'Opening...';
    try {
      await refreshSessions();
      renderSession(selectedSession() ?? session);
    } finally {
      button.disabled = false;
      button.textContent = 'Open Code Session';
    }
  });

document
  .querySelector('#work-search-form')
  .addEventListener('submit', async event => {
    event.preventDefault();
    const input = document.querySelector('#work-search');
    const value = input.value.trim();
    if (!value) {
      workSearchResults = [];
      renderWorkTrackingPanel();
      return;
    }
    const params = new URLSearchParams();
    if (/^[A-Z][A-Z0-9]+-\d+$/i.test(value)) {
      params.set('jiraKey', value.toUpperCase());
    } else {
      params.set('teamName', value);
    }
    const data = await api(`/work-tracking/sessions?${params.toString()}`);
    workSearchResults =
      data && Array.isArray(data.sessions) ? data.sessions : [];
    renderWorkTrackingPanel();
  });

function renderSession(session) {
  const target = document.querySelector('#code-output');
  const nextFrameKey = `${session.id}:${openCodeFrameUrl(session)}`;
  if (
    renderedCodeFrameKey === nextFrameKey &&
    target.classList.contains('code-session')
  ) {
    return;
  }
  renderedCodeFrameKey = nextFrameKey;
  target.className = 'code-session';
  target.innerHTML = '';

  const toolbar = document.createElement('div');
  toolbar.className = 'code-toolbar';

  const status = document.createElement('div');
  status.textContent = `OpenCortex Workbench for ${session.linuxUser}`;

  toolbar.append(status);

  const workspace = document.createElement('div');
  workspace.className = 'workspace';
  workspace.textContent = session.workspaceDir;

  renderWorkTrackingPanel();

  const link = document.createElement('a');
  link.href = openCodeFrameUrl(session);
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = 'Open in new tab';
  toolbar.append(link);

  const slack =
    session.channel?.external?.slack ?? selectedChannel()?.external?.slack;
  if (slack?.url) {
    const slackLink = document.createElement('a');
    slackLink.href = slack.url;
    slackLink.target = '_blank';
    slackLink.rel = 'noreferrer';
    slackLink.textContent = 'Open Slack';
    toolbar.append(slackLink);
  }

  const frame = document.createElement('iframe');
  frame.className = 'code-frame';
  frame.src = openCodeFrameUrl(session);
  frame.title = 'OpenCortex Workbench';
  frame.allow = 'clipboard-read; clipboard-write';

  target.append(toolbar, frame, workspace);
}

function renderWorkTrackingPanel() {
  const panel = document.querySelector('#work-tracking-panel');
  const session = selectedSession();
  panel.innerHTML = '';
  panel.hidden = !session && workSearchResults.length === 0;
  if (panel.hidden) return;

  if (session) {
    const row = document.createElement('div');
    row.className = 'work-row';
    const chips = document.createElement('div');
    chips.className = 'work-chips';
    for (const link of jiraLinks) {
      chips.append(workChip(link));
    }
    if (jiraLinks.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'work-empty';
      empty.textContent = 'No Jira tags';
      chips.append(empty);
    }
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'secondary';
    tag.textContent = 'Tag';
    tag.addEventListener('click', () => void tagSelectedSession());
    row.append(chips, tag);
    panel.append(row);
  }

  if (workSearchResults.length > 0) {
    const results = document.createElement('div');
    results.className = 'work-results';
    for (const result of workSearchResults.slice(0, 8)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'work-result';
      const tags = [
        ...(result.jiraItems ?? []).map(item => item.key),
        ...(result.teams ?? []).map(team => team.name),
      ];
      button.textContent = [
        result.channel?.name ?? result.id,
        result.ownerEmail,
        tags.join(', '),
      ]
        .filter(Boolean)
        .join(' · ');
      button.addEventListener('click', () => {
        if (result.channel?.id) {
          selectedChannelId = result.channel.id;
          renderChannels();
          void renderSelectedChannel();
        }
      });
      results.append(button);
    }
    panel.append(results);
  }
}

function renderObservabilityPanel() {
  const panel = document.querySelector('#observability-panel');
  if (!panel) return;
  panel.innerHTML = '';

  const heading = document.createElement('div');
  heading.className = 'observability-heading';
  const title = document.createElement('h3');
  title.textContent = 'Operations';
  const updated = document.createElement('span');
  updated.className = 'observability-updated';
  updated.textContent = observabilitySummary?.generatedAt
    ? `Updated ${formatRelativeTime(observabilitySummary.generatedAt)}`
    : '';
  heading.append(title, updated);
  panel.append(heading);

  if (!observabilitySummary) {
    panel.append(observabilityEmpty('Loading operational state'));
    return;
  }
  if (observabilitySummary.error) {
    panel.append(observabilityEmpty(observabilitySummary.error));
    return;
  }

  const stats = document.createElement('div');
  stats.className = 'observability-stats';
  stats.append(
    observabilityStat('Sessions', observabilitySummary.sessions?.active ?? 0),
    observabilityStat('Running', observabilitySummary.workflows?.running ?? 0),
    observabilityStat('Failed', observabilitySummary.workflows?.failed ?? 0),
    observabilityStat('Recent', observabilitySummary.workflows?.recent ?? 0),
  );
  panel.append(stats);

  const oldest = observabilitySummary.workflows?.oldestRunning;
  if (oldest) {
    const stuck = document.createElement('button');
    stuck.type = 'button';
    stuck.className = 'observability-item';
    stuck.textContent = [
      `Oldest running ${durationLabel(oldest.ageSeconds)}`,
      oldest.workflowType,
      oldest.summary,
    ]
      .filter(Boolean)
      .join(' - ');
    stuck.addEventListener('click', () => showWorkflowDetail(oldest));
    panel.append(stuck);
  }

  const failures = observabilitySummary.workflows?.failedItems ?? [];
  if (failures.length > 0) {
    const list = document.createElement('div');
    list.className = 'observability-list';
    for (const workflow of failures.slice(0, 3)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'observability-item failed';
      item.textContent = [
        workflow.workflowType,
        workflow.project,
        workflow.summary,
        workflow.traceId ? `trace ${workflow.traceId}` : undefined,
      ]
        .filter(Boolean)
        .join(' - ');
      item.addEventListener('click', () => showWorkflowDetail(workflow));
      list.append(item);
    }
    panel.append(list);
  }
}

function observabilityStat(label, value) {
  const stat = document.createElement('div');
  stat.className = 'observability-stat';
  const number = document.createElement('strong');
  number.textContent = String(value);
  const caption = document.createElement('span');
  caption.textContent = label;
  stat.append(number, caption);
  return stat;
}

function observabilityEmpty(text) {
  const empty = document.createElement('p');
  empty.className = 'observability-empty';
  empty.textContent = text;
  return empty;
}

function durationLabel(seconds) {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function showWorkflowDetail(workflow) {
  const lines = [
    workflow.workflowType,
    workflow.workflowId,
    workflow.status,
    workflow.summary,
    workflow.traceId ? `Trace: ${workflow.traceId}` : undefined,
  ].filter(Boolean);
  window.alert(lines.join('\n'));
}

function workChip(link) {
  const chip =
    link.kind === 'issue'
      ? document.createElement('button')
      : document.createElement('span');
  chip.className = `work-chip ${link.kind}`;
  chip.title = link.evidenceText;
  chip.textContent =
    link.kind === 'issue' ? link.targetKey : link.teamName || link.teamId;
  if (link.kind === 'issue') {
    chip.type = 'button';
    chip.addEventListener(
      'click',
      () => void showJiraItemDetail(link.targetKey),
    );
  }
  return chip;
}

async function showJiraItemDetail(key) {
  if (!key) return;
  const dialog = document.querySelector('#jira-dialog');
  const title = document.querySelector('#jira-dialog-title');
  const body = document.querySelector('#jira-dialog-body');
  if (!dialog || !title || !body) return;
  title.textContent = key.toUpperCase();
  body.innerHTML = '';
  body.textContent = 'Loading...';
  if (!dialog.open) {
    dialog.showModal();
  }
  try {
    const detail = await api(
      `/work-tracking/jira-items/${encodeURIComponent(key.toUpperCase())}`,
    );
    renderJiraItemDetail(detail);
  } catch (error) {
    body.textContent = error.message;
  }
}

function renderJiraItemDetail(detail) {
  const title = document.querySelector('#jira-dialog-title');
  const body = document.querySelector('#jira-dialog-body');
  if (!title || !body) return;
  const item = detail.item ?? {};
  title.textContent = detail.key;
  body.innerHTML = '';

  const summary = document.createElement('section');
  summary.className = 'jira-detail-section';
  const summaryTitle = document.createElement('h3');
  summaryTitle.textContent = item.summary || 'Tracked Jira item';
  const facts = document.createElement('dl');
  facts.className = 'jira-facts';
  appendFact(facts, 'Key', detail.key);
  appendFact(facts, 'Project', item.projectKey);
  appendFact(facts, 'Status', item.status);
  appendFact(facts, 'Assignee', item.assigneeEmail);
  appendFact(facts, 'Team', item.teamName);
  appendFact(
    facts,
    'Seen',
    [formatDateTime(detail.firstSeenAt), formatDateTime(detail.lastSeenAt)]
      .filter(Boolean)
      .join(' to '),
  );
  summary.append(summaryTitle, facts);

  const sessions = document.createElement('section');
  sessions.className = 'jira-detail-section';
  const sessionsTitle = document.createElement('h3');
  sessionsTitle.textContent = 'Workspace Sessions';
  const sessionList = document.createElement('div');
  sessionList.className = 'jira-session-list';
  for (const session of detail.sessions ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jira-session-item';
    button.textContent = [
      session.channel?.name ?? session.id,
      session.ownerEmail,
      session.workspaceDir,
    ]
      .filter(Boolean)
      .join(' · ');
    button.addEventListener('click', () => {
      if (session.channel?.id) {
        selectedChannelId = session.channel.id;
        document.querySelector('#jira-dialog')?.close();
        renderChannels();
        void renderSelectedChannel();
      }
    });
    sessionList.append(button);
  }
  sessions.append(sessionsTitle, sessionList);

  const evidence = document.createElement('section');
  evidence.className = 'jira-detail-section';
  const evidenceTitle = document.createElement('h3');
  evidenceTitle.textContent = 'Thread Evidence';
  const evidenceList = document.createElement('div');
  evidenceList.className = 'jira-evidence-list';
  for (const link of detail.links ?? []) {
    const row = document.createElement('article');
    row.className = 'jira-evidence';
    const meta = document.createElement('p');
    meta.className = 'jira-evidence-meta';
    meta.textContent = [
      link.source,
      link.createdByEmail,
      formatDateTime(link.createdAt),
    ]
      .filter(Boolean)
      .join(' · ');
    const text = document.createElement('p');
    text.textContent = link.evidenceText;
    row.append(meta, text);
    evidenceList.append(row);
  }
  evidence.append(evidenceTitle, evidenceList);

  const format = document.createElement('section');
  format.className = 'jira-detail-section';
  const formatTitle = document.createElement('h3');
  formatTitle.textContent = 'Creation Format';
  const pre = document.createElement('pre');
  pre.className = 'jira-format';
  pre.textContent = detail.integrationFormat?.descriptionSection ?? '';
  format.append(formatTitle, pre);

  body.append(summary, sessions, evidence, format);
}

function appendFact(target, label, value) {
  if (!value) return;
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  target.append(term, description);
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '';
}

async function tagSelectedSession() {
  const session = selectedSession();
  if (!session) return;
  const reference = window.prompt('Jira item, Jira URL, or team name');
  if (!reference) return;
  const body = { reference };
  if (!/[A-Z][A-Z0-9]+-\d+/i.test(reference)) {
    body.kind = 'team';
  }
  const data = await api(`/code/sessions/${session.id}/jira-links`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  jiraLinks = data && Array.isArray(data.links) ? data.links : jiraLinks;
  await refreshJiraLinks();
  renderWorkTrackingPanel();
}

function openCodeFrameUrl(session) {
  if (!session.openCodeSessionId) {
    return session.urlPath;
  }
  return (
    session.urlPath.replace(/\/?$/, '/') +
    base64UrlEncode(session.workspaceDir) +
    '/session/' +
    encodeURIComponent(session.openCodeSessionId)
  );
}

async function restoreSession() {
  try {
    await refreshSessions();
    selectInitialSessionChannel();
  } catch {
    // A failed restore is non-fatal; leave the empty state in place so the
    // user can open their workspace again.
  }
}

bindUiAction('#jira-dialog-close', 'click', () => {
  document.querySelector('#jira-dialog')?.close();
});

bindUiAction('#start-code', 'click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Opening...';

  const target = document.querySelector('#code-output');
  target.className = 'code-session loading';
  target.innerHTML = '';
  target.textContent = 'Opening OpenCortex Workbench...';

  try {
    const data = await api('/code/sessions', { method: 'POST' });
    if (!data) return;
    sessions = [
      { ...data.session, role: 'owner', channel: data.channel },
      ...sessions.filter(session => session.id !== data.session.id),
    ];
    selectedChannelId = data.channel.id;
    await refreshChannels();
    await renderSelectedChannel();
    renderSession(data.session);
  } catch (error) {
    target.className = 'code-session error';
    target.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Open Workbench';
  }
});

function renderSelectedChannelHeader() {
  const channel = selectedChannel();
  const title = document.querySelector('#channel-title');
  const meta = document.querySelector('#channel-meta');
  const share = document.querySelector('#share-channel');
  const open = document.querySelector('#open-selected-code');

  if (!channel) {
    title.textContent = 'TeamChat';
    meta.textContent = '';
    share.hidden = true;
    open.hidden = true;
    return;
  }

  title.textContent = channelTitle(channel);
  const owner = channel.members?.find(member => member.role === 'owner');
  const visibility =
    channel.visibility === 'team'
      ? 'Team visible'
      : channel.visibility === 'shared'
        ? `Shared with ${Math.max(0, channel.members.length - 1)}`
        : 'Private';
  meta.textContent = [visibility, owner ? `Owner ${owner.email}` : undefined]
    .filter(Boolean)
    .join(' · ');
  share.hidden =
    channel.type !== 'session' ||
    !channel.members?.some(
      member => member.email === currentUser?.email && member.role === 'owner',
    );
  open.hidden = !selectedSession();
}

async function renderSelectedChannel() {
  renderSelectedChannelHeader();
  await refreshSessions();
  await refreshMessages();
  markSelectedChannelSeen();
  await refreshPairPrompts();
  await refreshJiraLinks();
  renderChannels();
  renderPairPromptPanel();
  renderSelectedChannelHeader();
}

bindUiAction('#toggle-chat', 'click', () => {
  teamChatCollapsed = !teamChatCollapsed;
  setLocalStorageValue(
    teamChatCollapsedKey,
    legacyTeamChatCollapsedKey,
    String(teamChatCollapsed),
  );
  renderTeamChatShell();
});

bindUiAction('#sign-in', 'click', () => {
  sessionStorage.setItem(returnToKey, window.location.pathname);
  sessionStorage.removeItem(legacyReturnToKey);
  void login();
});

bindUiAction('#auth-screen-sign-in', 'click', () => {
  sessionStorage.setItem(returnToKey, window.location.pathname);
  sessionStorage.removeItem(legacyReturnToKey);
  void login();
});

bindUiAction('#sign-out', 'click', () => {
  void logout();
});

bindUiAction('#profile-link', 'click', () => {
  showProfile();
});

bindUiAction('#profile-close', 'click', () => {
  showWorkspace();
});

window.addEventListener('popstate', () => {
  currentView = window.location.pathname.endsWith('/profile')
    ? 'profile'
    : 'workspace';
  setAuthenticated(currentUser);
});

initPanelResizer();
renderTeamChatShell();

handleCallback()
  .then(async () => {
    if (!hasStoredToken()) {
      setAuthenticated(undefined);
      return undefined;
    }
    const me = await api('/me', { redirectOnUnauthorized: false });
    if (me) currentUser = me.user;
    if (!me) {
      sessionStorage.removeItem(tokenKey);
      sessionStorage.removeItem(accessTokenKey);
      sessionStorage.removeItem(legacyTokenKey);
      sessionStorage.removeItem(legacyAccessTokenKey);
      syncAuthCookie();
    }
    setAuthenticated(currentUser);
    return me;
  })
  .then(async me => {
    if (!me) return;
    await refreshChannels();
    await restoreSession();
    await renderSelectedChannel();
  })
  .then(() => {
    if (currentUser) {
      void startChatEvents();
      startSessionNameRefresh();
    }
  })
  .catch(error => {
    setAuthenticated(undefined);
    document.querySelector('#messages').textContent = error.message;
  });
