# Multiple workbench providers

**Status:** design, not started. Written 2026-08-21.

Today the workbench is opencode and only opencode. The goal is three options a
user picks per session:

| Provider | Surface | Subscription auth |
|---|---|---|
| `opencode` | opencode web (existing) | **API key only** — see below |
| `claude-code` | local `claude` CLI with Remote Control in claude.ai/code | Claude Pro/Max ✔ |
| `codex` | codexapp / codex-mobile web UI | ChatGPT Pro/Plus ✔ |

The motivation is not variety for its own sake. **opencode cannot spend a Claude
subscription** — it ships no Anthropic OAuth implementation (evidence in
`per-user-workbench-provider-auth.md`), so an Anthropic API key with usage
billing is its only option. Reaching a Claude subscription means running Claude
Code, and running Claude Code means a second provider.

## Terminology: a **workbench**, not a session

**"Session" belongs to the providers.** Every one of them already uses it for its
own internal conversation state — `openCodeSessionId`, Claude Code's
`user:sessions:claude_code` scope, codex sessions — and today OpenCortex competes
for the same word:

```ts
export interface CodeSession {     // ours
  id: string;
  openCodeSessionId?: string;      // theirs, nested inside ours
  threads?: CodeThread[];          // and a third session-ish noun
}
```

**A running provider instance for a user is a `workbench`.** It is already the
domain word — `packages/workbench`, `WorkbenchProvider`, `WorkbenchLaunchPlan`,
`OPENCORTEX_WORKBENCH_BIN` — and `Provider` → `Workbench` is the ordinary
factory-to-instance pair. It reads correctly as a countable noun, which is what
the dashboard needs: *open a new workbench*, *your Claude Code workbench*, *group
workbenches by project*.

| Term | Means |
|---|---|
| **provider** | The kind of workbench: `opencode`, `claude-code`, `codex` |
| **workbench** | One running provider instance for one owner, with members, a port, a URL, and a project/topic label |
| **session** | Whatever the provider calls its own internal conversation. Not ours. |
| **thread** | A conversation within a workbench, where the provider exposes one |
| workspace / `workspaceDir` | Unchanged — the repos directory on disk |

The rename is mechanical: `CodeSession` → `Workbench`, `sessionStore` →
`workbenchStore`, `/code/sessions` → `/workbenches`, `reusableWorkspaceSession`
→ a workbench lookup. Around 130 references. **Do it before the two new providers
exist**, not after — the id scheme is changing anyway (see below), so the two
changes touch the same code, and every week of delay triples the surface.

Where a provider's own session id is stored on a workbench, name it for the
provider (`openCodeSessionId`, `claudeCodeSessionId`) so the distinction stays
visible at the call site.

## Work tracking: absorb Jira into provider-agnostic tasks

The Jira feature was solving the same problem Kepler exposes more clearly:
sessions need to be organized around the work they are advancing, not around the
chat surface that happened to mention an issue key. Keep the capability, but
move the vocabulary up a level.

Current Jira-specific behavior becomes the first adapter for a generic work
tracking model:

| Current Jira concept | Generic OpenCortex concept |
|---|---|
| `JiraSessionLink` | `WorkReference` |
| Jira issue key | external work item key |
| Jira issue/team cache | provider-specific work item cache |
| `/work-tracking/jira-items` | `/work-tracking/items?provider=jira` |
| chat/manual/Jira enrichment source | evidence source on a work reference |
| `jiraLinks.updated` | `workReferences.updated` |

The generic record should carry `provider`, `kind`, `externalId`, `key`, `url`,
`title`, `status`, `team`, `project`, `labels`, `source`, `confidence`, and an
`evidenceRef`. Jira remains important, but it should be one value of
`provider`, not the name of the model. Other adapters can then add Linear,
GitHub Issues, GitLab Issues, Azure DevOps, Trello, pull requests, documents, or
plain manually-created work items without reworking the session manager.

This also changes the top-level product object:

| Term | Means |
|---|---|
| **task / work item** | One unit of desired outcome, independent of provider and possibly spanning several repos |
| **work reference** | A link from a task/workbench to Jira, Linear, GitHub, PR, document, or another external planning artifact |
| **workbench** | One running provider instance assigned to a task or work item |
| **provider session** | The provider's internal conversation/process id, such as `openCodeSessionId`, `claudeCodeSessionId`, or a Codex session id |

OpenCortex should create tasks from the same places Kepler does:

1. From scratch: a user writes an objective and optionally attaches repos,
   documents, or prior sessions.
2. From an issue: Jira first, then Linear/GitHub/GitLab/Azure/Trello adapters.
3. From a pull request: import PR metadata, review comments, CI status, and
   changed files so an agent can review or address feedback.

The existing Jira UI and APIs should migrate rather than disappear. The concrete
implementation path is to introduce generic names beside the current Jira
surface, dual-write or adapt reads for one release, then retire Jira-specific
route names once the dashboard speaks `WorkReference`. The context-pack builder
for Claude/Codex/OpenCode should consume the generic shape, so "include Jira
context" becomes "include attached work references" and the provider-specific
formatting lives in the adapter.

## Decision: adopt ACP as the provider control plane

Adopt the Agent Client Protocol (ACP) for OpenCortex's agent/workbench control
surface. MCP remains the protocol agents use to reach tools and services; ACP is
the protocol OpenCortex uses, as the orchestrating client, to start tasks, send
prompts, observe progress, display diffs, and coordinate provider sessions.

This should become the default integration boundary for providers that support
it. Kepler's public design validates the same split: the ADE is the client, and
harnesses such as Claude Code, Codex, OpenCode, Gemini, Cursor, Copilot, and
Augment are agents behind a common protocol. The point is not protocol fashion;
it is avoiding a bespoke adapter for every agent UI and CLI behavior.

OpenCortex should model providers in two layers:

| Layer | Responsibility |
|---|---|
| `WorkbenchProvider` | local process/runtime launch, identity, environment, worktree, URLs, lifecycle |
| `AgentClient` / ACP adapter | prompt delivery, streaming status, permission requests, diffs, tool events, session state |

For near-term providers:

| Provider | ACP stance |
|---|---|
| `claude-code` | Prefer ACP when running as an orchestrated agent; also support Claude Remote Control when the desired user surface is `claude.ai/code`. |
| `codex` | Prefer ACP/Codex CLI integration for task execution; keep codexapp only as a transitional web UI surface. |
| `opencode` | Add an ACP adapter if/when the selected opencode runtime supports it; until then keep the existing HTTP/web provider behavior behind the same OpenCortex task model. |

The user-facing dashboard should not care which provider path is underneath. It
should show tasks, work references, worktrees, provider sessions, current status,
pending human actions, diffs, commits, PRs, and costs. ACP supplies the common
event vocabulary for the parts that belong to the agent interaction; OpenCortex
adds the higher-level task, identity, memory, project-management, and deployment
context around it.

Implementation order:

1. Define OpenCortex's internal `AgentClient` interface around ACP concepts:
   initialize session, send prompt/context pack, stream events, request/record
   approvals, expose diffs, and terminate/resume.
2. Add ACP event persistence to the activity ledger so prompt, model/tool,
   permission, diff, commit, PR, and failure events are attributable to a task
   and workbench.
3. Add provider adapters in priority order: Claude Code, Codex, then OpenCode.
4. Keep provider-specific escape hatches where they are valuable, especially
   Claude Remote Control deep links and Codex web/mobile links.

Do not block the task/work-reference migration on ACP completeness. The generic
task model is useful immediately, and ACP can fill in richer provider telemetry
as each adapter comes online.

## The launch interface is already close

`packages/workbench` needs no architectural rewrite for process launch.
`WorkbenchProvider` is already `id` + `version` +
`planLaunch(request) → WorkbenchLaunchPlan`, and the plan is provider-agnostic:
`command[]`, `environment`, `runtimeDirs`, `urlPath`. `SessionLauncher` consumes
only those fields — port allocation, the sudo-to-linuxUser wrapper, and the
iframe path are all generic already.

That interface is the lower layer. It starts and supervises local runtime
surfaces. It should not grow into the agent conversation protocol; ACP belongs in
the sibling `AgentClient` layer described above.

Exactly one line pins it to a single provider:

```ts
export type WorkbenchProviderId = typeof OPENCODE_PROVIDER_ID;   // a union of one
```

Widen to `"opencode" | "claude-code" | "codex"`, add two classes beside
`OpenCodeWorkbenchProvider`, and select one per session.

Two config assumptions break, both small:

- `OPENCORTEX_WORKBENCH_BIN` is a single binary path. Becomes per-provider.
- `PINNED_OPENCODE_VERSION` is already provider-specific; it moves onto its class.

Session records will need to carry the chosen `providerId` so a relaunch restores
the same provider, and `reusableWorkspaceSession()` will need to decide what
"reusable" means when a user's existing session is a *different* provider than
the one they just asked for. That decision is open — see below.

## claude-code: manage local Claude Code sessions through Remote Control

**The rule that keeps this sanctioned: shell out to `claude`, and never read its
credential.** Third-party editors integrate with Claude by driving Anthropic's own
client, which owns the login; the editor never holds a subscription token. Taking
the token out of `~/.claude/.credentials.json` and calling `api.anthropic.com`
directly is the thing that is not sanctioned — and is precisely why opencode has
no Pro/Max flow to copy.

Verified on this host (`claude` 2.1.225):

```
$ claude auth status
{ "loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "pro", ... }
```

- `claude auth login --claudeai` — "Use Claude subscription (default)".
- `claude auth status` emits **JSON** — this is the credential precondition check
  the other note asks for, machine-readable, no output scraping.
- `claude setup-token` — "long-lived authentication token (requires Claude
  subscription)", the official headless artifact.

**Surface: Claude's own web/mobile UI, not an OpenCortex terminal UI.** Claude
Code Remote Control connects a local Claude Code process to `claude.ai/code` and
the Claude app while execution, filesystem access, MCP servers, tools, and
project configuration stay on the local machine. OpenCortex should therefore be
the launcher, context assembler, and lifecycle manager; Claude owns the
conversation UI, tool approval UX, and subscription login.

Each new OpenCortex workbench request becomes a new Claude Code session:

1. Resolve the user identity to the target Linux account and home directory.
2. Resolve the starting directory from the request: selected repo first, then
   project workspace, then `/home/<linuxUser>/repos`.
3. Build a deterministic display name from project, Jira issue, topic, or linked
   workbench reference.
4. Generate a UUID for `claudeCodeSessionId` and store it on the OpenCortex
   workbench record.
5. Assemble the initial prompt from OpenCortex context:
   - user objective entered at creation time;
   - project/repo path and branch expectations;
   - attached work references, including Jira issue keys, titles, status, and
     links when the reference came from Jira;
   - referenced OpenCortex workbenches and their summaries;
   - relevant memory entries for the same project/repo/topic;
   - operating constraints, including "do not commit or push unless asked" and
     any requested permission mode.
6. Launch the real Claude Code CLI in a PTY-backed process supervisor with Remote
   Control enabled:

   ```bash
   claude --remote-control "<display name>" \
     --session-id "<uuid>" \
     --name "<display name>" \
     "<initial prompt>"
   ```

The PTY matters. Claude Code is an interactive client, and Remote Control is
tied to a live local session. A detached process with stdin ignored is the wrong
primitive; the provider needs a terminal/session supervisor even if OpenCortex
does not expose that terminal as the primary UI. `tmux`, `zellij`, or a small
node-pty based supervisor are all reasonable implementation choices. The
supervisor's job is process lifetime, stdout capture, exit status, and optional
operator attach for debugging.

Store two URLs:

- `providerUrl`: the best link OpenCortex can show the user. Prefer the
  per-session Remote Control URL if Claude prints or exposes it.
- `providerFallbackUrl`: `https://claude.ai/code`.

Official Claude Code docs say the Remote Control status panel exposes a session
URL that opens directly in `claude.ai/code`, and current Claude Code (`2.1.251`
on this host) supports `--remote-control`, `--session-id`, `--name`,
`--settings`, `--mcp-config`, `--add-dir`, `--permission-mode`, `--resume`, and
background/session commands. Do not assume the claude.ai URL is derivable from
the UUID unless the CLI emits a stable link; capture it from the CLI output or
status surface when available, otherwise show the fallback.

This makes the Claude provider different from opencode and codex: OpenCortex
does not proxy or iframe its UI. It opens a Claude-hosted control surface for a
local process that OpenCortex launched and can monitor.

## codex: wrap the already-running codexapp

codex-mobile (https://github.com/friuns2/codex-mobile) is installed and running
here as a user service:

```
node ~/.local/share/codex-webui/node_modules/codexapp/dist-cli/index.js \
  --no-tunnel --no-open --no-login --port 5900 --password ***
```

It takes `--port`, so it drops into the same per-session launch model. Its device
auth relay already exists in the intelligent-processor repo and ports directly:
spawn `codex login --device-auth` under `script -q -f -c` so the CLI believes it
is on a PTY, tail the log, regex out the verification URL and code, relay both to
the browser, and let the CLI complete the exchange itself. The backend never
handles a token — same principle as the claude-code rule above.

## Cross-cutting: everything is installed in one user's home

```
/home/mfox/.local/bin/claude          -> ~/.local/share/claude/versions/2.1.225
/home/mfox/.local/share/codex-webui/  (codexapp)
/home/mfox/.local/share/opencode/     (credentials)
```

**None of the three providers is installed system-wide.** A newly provisioned
user gets a home with none of them, so all of this works only for the operator
today. `claude` and `codexapp` belong in provisioning next to `node`, `git`, and
`opencode` (`OPENCORTEX_PROVISIONING_REQUIRED_TOOLS`).

This is the same second-user cliff as the empty `auth.json`, and it is invisible
until someone other than the operator opens a workbench.

## Cross-cutting: binding and session isolation

opencode sessions bind `127.0.0.1` and sit behind OpenCortex auth. The two
services running today do not:

- codexapp: `0.0.0.0:5900`, reachable across the tailnet behind one shared
  password (`--no-login --password`), which is a single secret rather than a
  per-user credential.
- `zellij web`: `0.0.0.0:8082`.

As providers, both should bind loopback and let OpenCortex's auth front them, the
way opencode already does. Per-session ports plus loopback binding is also what
keeps one user out of another user's session — worth settling before either
provider is exposed to a second user.

## Decided (2026-08-21): the dashboard manages many sessions across providers

Three decisions that together replace the open questions this section used to
hold.

**1. A user has many sessions, not one.** OpenCortex should let a user manage and
access sessions for *all* providers from the dashboard — so "switch a session's
provider" is the wrong frame. Provider is chosen when a session is created and
fixed for its life; wanting a different provider means creating another session,
and both stay in the inventory.

**2. Sessions are grouped by project and/or topic.** The dashboard's job is
inventory and organisation — list, group, launch — rather than being the place
the work happens.

**3. The embedded live workbench goes away.** Sessions open in their own tab or
window. Dropping the iframe is what makes the dashboard good at managing and
grouping many sessions instead of hosting one.

Note this does not disturb the sharing model. A session is still a stable,
shareable place with an owner and channel members; there are simply several of
them per user now. What dissolves is only the *one-per-user* part.

### The blocker: session IDs are derived from the Linux user

```ts
// sessionLauncher.ts:215
return `workspace-${user.linuxUser}`;
```

**A user cannot have two sessions today** — the ID is a pure function of the
Linux user, so a second session would collide with the first. This is the reason
the existing behaviour is one-per-user, more than any deliberate rule; it is
mechanical, not policy.

Interestingly `SessionStore.findByOwnerEmail()` already sorts by `createdAt`
descending and returns `[0]`, i.e. it is written as though several sessions per
owner were possible. The ID collision is what prevents it. So the store is closer
to ready than the launcher.

What changes:

- **Session ID** gains a discriminator — provider plus a project/topic slug, or a
  generated id with those as fields. `workspace-${linuxUser}` cannot survive.
- **`findByOwnerEmail`** becomes a filtered list query (owner + provider +
  project), not a single-result lookup.
- **`reusableWorkspaceSession()`** matches within a provider/project rather than
  "the user's session". Reuse still matters — it is what stops every dashboard
  visit spawning processes — but the key widens.
- **The session record** carries `providerId` and a project/topic label, so a
  relaunch restores the right provider and the dashboard can group without
  guessing.
- **`urlPath`** stays, but as a `window.open` target rather than an iframe `src`.
  This removes the iframe/CSP constraints on every provider, which is a
  simplification for the terminal and codexapp surfaces in particular.

One consequence worth noting for the credential work in the sibling note:
deleting a session to pick up a new credential gets much cheaper when a user has
several and can spin another for that provider, rather than destroying the one
session they have.

### Not a concern: guests on a terminal

An earlier draft flagged that "guests advise, never prompt" is hard to enforce on
a raw terminal, since anyone who can see it can type into it. **Decided: moot.**
Users understand the risk of inviting someone into a terminal session. This is a
trust decision by the owner at invite time, not something the platform needs to
gate — and treating it as a blocker would rule out the terminal provider for no
real gain.

## RESOLVED (2026-08-21): `claude auth login` does relay headlessly

Tested. The CLI attempts a browser, then prints the URL and waits:

```
Opening browser to sign in...
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-...
Paste code here if prompted >
```

Two things fall out of this.

**It corroborates the opencode correction.** That `client_id`,
`9d1c250a-e61b-44d9-88ed-5944d1962f5e`, is the Claude Code OAuth client — the
exact value searched for in the opencode binary, with zero hits. Present in
`claude`, absent from opencode.

**The callback is hosted by Anthropic.** `redirect_uri` is
`platform.claude.com/oauth/code/callback`, so there is no localhost listener to
run and no port to allocate for the auth flow itself. Good for a web relay.

Scopes requested: `org:create_api_key`, `user:profile`, `user:inference`,
`user:sessions:claude_code`, `user:mcp_servers`, `user:file_upload`.

### The relay is bidirectional, unlike codex

This is the part that does **not** port from the intelligent-processor
implementation. The code travels the opposite direction:

| | codex | claude |
|---|---|---|
| CLI emits | device URL **and** code | authorize URL |
| User does | enters the CLI's code in the browser | authorizes; Anthropic shows a code |
| Code flows | UI → browser | **browser → CLI stdin** |
| Relay needs | read stdout | **read stdout and write stdin** |

The existing codex relay spawns under `script -q -f -c` with `stdout=DEVNULL,
stderr=DEVNULL` and tails a log file — it never writes to the child. For `claude`
something has to type the pasted code back into a waiting prompt, so the relay
needs a real bidirectional PTY (`node-pty`, or a FIFO wired to stdin). Budget for
that rather than assuming the codex code is reusable as-is.

Worth noting the terminal provider may make this moot for `claude-code`
specifically: if the session is already a browser terminal via `zellij web`, the
user can run `claude auth login` in it and paste the code themselves, with no
relay to build at all. The relay matters for provisioning a credential *before*
a session exists, or for a non-terminal Claude UI later.
