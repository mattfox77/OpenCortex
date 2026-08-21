# Multiple workbench providers

**Status:** design, not started. Written 2026-08-21.

Today the workbench is opencode and only opencode. The goal is three options a
user picks per session:

| Provider | Surface | Subscription auth |
|---|---|---|
| `opencode` | opencode web (existing) | **API key only** — see below |
| `claude-code` | `claude` CLI in a browser terminal | Claude Pro/Max ✔ |
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

## The interface is already right

`packages/workbench` needs no architectural change. `WorkbenchProvider` is
already `id` + `version` + `planLaunch(request) → WorkbenchLaunchPlan`, and the
plan is provider-agnostic: `command[]`, `environment`, `runtimeDirs`, `urlPath`.
`SessionLauncher` consumes only those fields — port allocation, the sudo-to-
linuxUser wrapper, and the iframe path are all generic already.

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

## claude-code: drive the CLI, never extract the token

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

**Surface: a browser terminal via zellij, not a bespoke UI.** `zellij web` serves
terminal sessions over HTTP and is already running on this host
(`zellij 0.43.1`, `zellij web --start`), so per-session it is the same shape as
opencode: allocate a port, run as the session's Linux user, iframe it. Everything
Claude Code does — streaming, tool approval prompts, slash commands — works
unchanged because it is the real CLI in a real terminal, with no UI to
reimplement.

A purpose-built web UI over Claude Code is the nicer product and much more work;
the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, Claude Code as a library)
is the honest path to it. Ship the terminal first; treat a custom UI as a later
upgrade rather than a prerequisite.

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
