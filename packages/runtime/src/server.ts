import { createApp } from './http/app.js';
import { loadConfig } from './config/config.js';
import { SessionStore } from './code/sessionStore.js';
import { ChatStore } from './chat/chatStore.js';
import { JiraTrackingStore } from './jira/jiraTrackingStore.js';

const config = loadConfig();
const codeSessions = new SessionStore(config.OPENCORTEX_DATA_DIR);
const chat = new ChatStore(config);
const jiraTracking = new JiraTrackingStore(config.OPENCORTEX_DATA_DIR);

// Reload sessions that survived a restart before serving requests. Sessions
// whose OpenCode process is no longer listening are kept so request handlers can
// relaunch them from persisted metadata instead of losing the workspace.
const prunedSessions = await codeSessions.init();
for (const session of prunedSessions) {
  chat.archiveSessionChannel(session);
}

const app = createApp(config, codeSessions, chat, undefined, jiraTracking);

app.listen(config.PORT, () => {
  console.log(`OpenCortex runtime listening on :${config.PORT}`);
});
