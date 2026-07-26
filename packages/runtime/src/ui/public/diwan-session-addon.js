function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function style(el, values) {
  Object.assign(el.style, values);
  return el;
}

function addonConfig(root) {
  return {
    apiBaseUrl: root.dataset.apiBaseUrl,
    channelId: root.dataset.channelId,
    channelName: root.dataset.channelName || 'New session',
    diwanUrl: root.dataset.diwanUrl,
    slackUrl: root.dataset.slackUrl,
  };
}

function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
}

function sessionRecords(payload) {
  if (Array.isArray(payload)) return payload.filter(recordValue)
  const root = recordValue(payload)
  if (!root) return []
  for (const source of [root, recordValue(root.data)]) {
    if (!source) continue
    for (const key of ['sessions', 'session', 'items', 'data']) {
      const value = source[key]
      if (Array.isArray(value)) return value.filter(recordValue)
    }
  }
  return []
}

function stringValue(source, key) {
  const value = recordValue(source)?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function timestampFromValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 100000000000 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return timestampFromValue(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function sessionTimestamp(record) {
  const info = recordValue(record.info)
  const project = recordValue(record.project)
  for (const source of [record, info, project]) {
    if (!source) continue
    for (const key of [
      'updatedAtMs',
      'updated_at_ms',
      'lastMessageAt',
      'lastActivityAt',
      'updatedAt',
      'updated_at',
      'createdAtMs',
      'created_at_ms',
      'createdAt',
      'created_at',
    ]) {
      const timestamp = timestampFromValue(source[key])
      if (timestamp) return timestamp
    }
  }
  return undefined
}

function compactRelativeTime(timestamp) {
  if (!Number.isFinite(timestamp)) return ''

  const diffMs = Math.abs(Date.now() - timestamp)
  if (diffMs < 60000) return 'now'

  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  return `${days}d`
}

function sessionIdFromUrl(value) {
  try {
    const url = new URL(value, document.baseURI)
    const match = url.pathname.match(/(?:^|\/)session\/([^/?#]+)/)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  } catch {
    const match = String(value).match(/(?:^|\/)session\/([^/?#]+)/)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  }
}

function ensureDysonSessionAgeStyles() {
  if (document.querySelector('style[data-diwan-dyson-session-age]')) return
  const styles = createEl('style')
  styles.dataset.diwanDysonSessionAge = 'true'
  styles.textContent = `
    .diwan-dyson-session-age {
      color: rgb(113 113 122);
      flex: 0 0 auto;
      font-size: 0.875rem;
      font-weight: 400;
      line-height: 1.25rem;
      margin-left: 0.5rem;
      white-space: nowrap;
    }
  `
  document.head.append(styles)
}

async function dysonSessionTimeMap() {
  const data = await jsonFetch(new URL('api/session', document.baseURI).toString())
  const map = new Map()
  for (const record of sessionRecords(data)) {
    const id =
      stringValue(record, 'id') ||
      stringValue(record, 'sessionId') ||
      stringValue(record, 'sessionID')
    const timestamp = sessionTimestamp(record)
    if (id && timestamp) map.set(id, timestamp)
  }
  return map
}

function annotateDysonSessionRows(sessionTimes) {
  ensureDysonSessionAgeStyles()
  for (const link of document.querySelectorAll('a[href*="/session/"]')) {
    const id = sessionIdFromUrl(link.getAttribute('href') || '')
    const timestamp = id ? sessionTimes.get(id) : undefined
    const label = compactRelativeTime(timestamp)
    const existing = link.querySelector(':scope > .diwan-dyson-session-age')
    if (!label) {
      existing?.remove()
      continue
    }
    const age = existing || createEl('span', 'diwan-dyson-session-age')
    age.textContent = label
    age.title = new Date(timestamp).toLocaleString()
    if (!existing) link.append(age)
  }
}

function initDysonSessionAges() {
  let latest = new Map()
  let refreshInFlight = false

  async function refresh() {
    if (refreshInFlight) return
    refreshInFlight = true
    try {
      latest = await dysonSessionTimeMap()
      annotateDysonSessionRows(latest)
    } catch {
      // The upstream OpenCode API differs across versions; leave the UI alone
      // when this version does not expose session timestamps.
    } finally {
      refreshInFlight = false
    }
  }

  const observer = new window.MutationObserver(() => {
    if (latest.size > 0) annotateDysonSessionRows(latest)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  void refresh()
  window.setInterval(refresh, 60000)
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function renderMessageList(target, messages) {
  target.innerHTML = '';
  for (const message of messages) {
    const row = style(createEl('div'), {
      borderBottom: '1px solid #2c2c2c',
      padding: '8px 0',
    });
    const meta = style(createEl('div'), {
      color: '#a3a3a3',
      fontSize: '11px',
      marginBottom: '3px',
    });
    meta.textContent = `${message.authorEmail} · ${new Date(message.createdAt).toLocaleString()}`;
    const body = style(createEl('div'), {
      color: '#f4f4f5',
      fontSize: '13px',
      lineHeight: '1.35',
      overflowWrap: 'anywhere',
      whiteSpace: 'pre-wrap',
    });
    body.textContent = message.body;
    row.append(meta, body);
    target.append(row);
  }
  target.scrollTop = target.scrollHeight;
}

function initAddon(root) {
  const config = addonConfig(root);
  if (!config.apiBaseUrl || !config.channelId) {
    root.remove();
    return;
  }

  const shell = style(root, {
    bottom: '16px',
    color: '#f4f4f5',
    font: '13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    position: 'fixed',
    right: '16px',
    zIndex: '2147483647',
  });

  const panel = style(createEl('section'), {
    background: '#18181b',
    border: '1px solid #3f3f46',
    borderRadius: '8px',
    boxShadow: '0 18px 44px rgba(0,0,0,.38)',
    display: 'none',
    marginBottom: '8px',
    overflow: 'hidden',
    width: '360px',
  });

  const heading = style(createEl('div'), {
    alignItems: 'center',
    borderBottom: '1px solid #2c2c2c',
    display: 'flex',
    gap: '8px',
    justifyContent: 'space-between',
    padding: '10px 12px',
  });
  const title = style(createEl('strong', undefined, config.channelName), {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  const links = style(createEl('div'), {
    display: 'flex',
    gap: '8px',
  });
  for (const [label, href] of [
    ['DIWAN', config.diwanUrl],
    ['Slack', config.slackUrl],
  ]) {
    if (!href) continue;
    const link = style(createEl('a', undefined, label), {
      color: '#93c5fd',
      fontSize: '12px',
      fontWeight: '700',
      textDecoration: 'none',
    });
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer';
    links.append(link);
  }
  heading.append(title, links);

  const messages = style(createEl('div'), {
    maxHeight: '320px',
    minHeight: '160px',
    overflow: 'auto',
    padding: '0 12px',
  });

  const form = style(createEl('form'), {
    borderTop: '1px solid #2c2c2c',
    display: 'flex',
    gap: '8px',
    margin: '0',
    padding: '10px',
  });
  const input = style(createEl('input'), {
    background: '#09090b',
    border: '1px solid #3f3f46',
    borderRadius: '6px',
    color: '#f4f4f5',
    flex: '1',
    minHeight: '34px',
    padding: '0 9px',
  });
  input.placeholder = 'Message session';
  const send = style(createEl('button', undefined, 'Send'), {
    background: '#1d4ed8',
    border: '1px solid #2563eb',
    borderRadius: '6px',
    color: '#fff',
    cursor: 'pointer',
    fontWeight: '700',
    minHeight: '34px',
    padding: '0 10px',
  });
  form.append(input, send);

  const toggle = style(createEl('button', undefined, 'TeamChat'), {
    background: '#ffffff',
    border: '1px solid #cfd6dd',
    borderRadius: '6px',
    boxShadow: '0 8px 24px rgba(15,23,42,.18)',
    color: '#0f172a',
    cursor: 'pointer',
    font: '700 13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    minHeight: '38px',
    padding: '0 12px',
  });

  async function refreshMessages() {
    messages.textContent = 'Loading...';
    const data = await jsonFetch(
      `${config.apiBaseUrl}/chat/channels/${encodeURIComponent(config.channelId)}/messages`,
    );
    renderMessageList(messages, data.messages || []);
  }

  toggle.addEventListener('click', () => {
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    if (!open) void refreshMessages().catch(error => {
      messages.textContent = error.message;
    });
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    void jsonFetch(
      `${config.apiBaseUrl}/chat/channels/${encodeURIComponent(config.channelId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ body }),
      },
    )
      .then(refreshMessages)
      .catch(error => {
        messages.textContent = error.message;
      });
  });

  panel.append(heading, messages, form);
  shell.append(panel, toggle);
}

for (const root of document.querySelectorAll('[data-diwan-session-addon]')) {
  initAddon(root);
}

initDysonSessionAges()
