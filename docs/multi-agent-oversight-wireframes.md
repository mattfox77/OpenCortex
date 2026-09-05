# Multi-agent oversight wireframes

**Status:** low-fidelity product wireframes. Written 2026-09-04.

HTML version: [multi-agent-oversight-wireframes.html](multi-agent-oversight-wireframes.html).

These wireframes translate the multi-agent oversight design into screens. They
are intentionally structural: labels, hierarchy, state, and actions matter more
than visual styling. OpenCortex should feel like an operations console for agent
work, not a provider chat clone.

## UX audit and revisions

This revision applies WCAG 2.2 and current data-heavy application patterns to
the oversight concept. The main correction is to make the product an
attention-driven control surface rather than a passive inventory of sessions.

Findings, ordered by user impact:

1. **Exceptions were visible but not prioritized.** A persistent attention
   queue now precedes the task table and orders approvals, failures, blocked
   launches, stale agents, and policy violations by urgency.
2. **Machine and human states were conflated.** Task and agent views now show
   execution state separately from review/approval state. A running agent may
   still be waiting for a human decision.
3. **Recovery was underspecified.** Launch preflight and operational surfaces
   now name the affected task, provider, host, or field; explain the failure;
   preserve entered values; and offer a concrete retry or repair action.
4. **Evidence and freshness were too implicit.** Decision surfaces now require
   source, observed-at timestamp, provenance, reviewer, and confidence or
   estimation basis where relevant.
5. **Dense tables lacked expert controls.** Large inventories now require
   visible sort state, search, filters, saved views, column selection, compact
   density, sticky headings, row expansion, and a clear count/freshness line.
6. **The wireframe did not demonstrate its accessibility contract.** The HTML
   artifact now uses semantic navigation, a skip link, visible keyboard focus,
   labeled controls, accessible tab semantics, table captions, text status
   labels, and live-status/alert regions.

Design baseline:

- WCAG 2.2 AA is required; enhanced focus appearance is adopted where practical.
- Dashboard summaries route users to work and never replace record detail.
- Progressive disclosure keeps common decisions visible while moving raw logs,
  IDs, and diagnostics into expandable detail.
- Mobile is for triage, approval, status, and intervention; dense development
  operations remain desktop-first.
- Auto-refresh updates only the affected region, announces material changes,
  and never steals focus.

## Product intent

```text
+------------------------------------------------------------------------------+
| OpenCortex                                                                    |
| Web control plane for distributed agent work                                  |
+------------------------------------------------------------------------------+
|                                                                              |
|  Authenticated user                                                           |
|        |                                                                      |
|        v                                                                      |
|  Task / objective -- Work references -- Context pack -- Skill bundle -- Policy|
|        |              Jira, GitHub, docs     memory, repo    installable caps  |
|        |                                                                      |
|        v                                                                      |
|  Workbench request                                                            |
|        |                                                                      |
|        +-- Host selection: runtime host, Tailscale host, capability, load      |
|        +-- Linux user mapping and provider auth readiness                     |
|        +-- Worktree preparation                                               |
|        +-- Temporal child workflow supervises one provider workbench          |
|        +-- Provider process: Claude Code, Codex, OpenCode, future ACP agents  |
|                                                                              |
|        v                                                                      |
|  Oversight loop                                                               |
|  status  events  approvals  diffs  tests  commits  PRs  memory  replay       |
|                                                                              |
+------------------------------------------------------------------------------+
```

## Global shell

Every screen keeps the same shell so users always know scope, health, and active
work.

```text
+------------------------------------------------------------------------------+
| OpenCortex        Search tasks, sessions, repos, issues...              mfox |
+---------------+--------------------------------------------------------------+
| Tasks         | Environment: Local install        OIDC: Google         Live   |
| Agents        | Host scope: All hosts             Tenant: tssoft              |
| Hosts         +--------------------------------------------------------------+
| Review        | Page content                                                 |
| Ledger        |                                                              |
| Memory        |                                                              |
| Skills        |                                                              |
| Settings      |                                                              |
+---------------+--------------------------------------------------------------+
```

Persistent header signals:

- signed-in user and tenant;
- OIDC issuer and auth health;
- runtime health;
- selected host scope;
- global search across tasks, workbenches, work references, memories, and
  artifacts.

Keyboard users receive a skip link into main content, stable focus order, and a
high-contrast focus indicator. Navigation marks the current view
programmatically as well as visually.

## Tasks dashboard

Primary job: know what work exists, where agents are active, and what needs
attention.

The default saved view is **My attention queue**, sorted by required action and
then urgency. The dashboard exposes Temporal orchestration state, provider
execution state, and reviewer state as separate columns. It shows record count,
active filters, default sort, live connection state, and data freshness above
the table.

```text
+------------------------------------------------------------------------------+
| Tasks                                                   + New Task   + Launch |
+------------------------------------------------------------------------------+
| Needs attention: 4    Running: 9    Review ready: 3    Failed: 1    $18.42   |
| [Approvals 2] [Blocked 1] [Stale 1] [Hosts 3/4] [Cost today $18.42]          |
+------------------------------------------------------------------------------+
| Needs attention                                                              |
| Failed: Host agent / OpenCode port conflict                  View recovery    |
| Approval: ACP adapter plan / due 11:30                       Review plan      |
+------------------------------------------------------------------------------+
| Saved: My attention queue  Sort: Next action  Columns v  Density: Compact    |
| Filters: Project v  Owner v  Provider v  State v  Work Ref v  Host v         |
+--------+------+-------------+----------+----------+---------+-------+---------+
| Orch   | Exec | Task        | Review   | Work ref | Agents  | Cost  | Next    |
+--------+------+-------------+----------+----------+---------+-------+---------+
| Active | Run  | OIDC polish | Ready    | JIRA-42  | Claude  | $3.11 | Review  |
| Wait   | Run  | ACP adapter | Plan due | GH#118   | Codex   | $7.80 | Plan    |
| Recover| ?    | Host agent  | n/a      | Manual   | OpenCode| $0.16 | Recover |
| Draft  | n/a  | Skill import| None     | OC-S-19  | 0       | $0.00 | Context |
+--------+------+-------------+----------+----------+---------+-------+---------+
```

Row expansion:

```text
+------------------------------------------------------------------------------+
| OIDC polish                                                                  |
| Objective: finish Google OIDC readiness and status docs                       |
| Work refs: JIRA-42, PR #31                                                    |
| Workbenches: claude-code on linux-macbook as ada, codex on fedora-2 as mfox   |
| Latest: tests passed, waiting for PR approval                                 |
| Actions: Open task  Open provider  Request status  Hand off  Archive          |
+------------------------------------------------------------------------------+
```

## Task detail

Primary job: operate one unit of work across references, agents, context,
review, and output.

```text
+------------------------------------------------------------------------------+
| Task: ACP provider adapter                                          Rename ...|
| Running       Owner: mfox       Project: OpenCortex       Priority: High      |
+------------------------------------------------------------------------------+
| Objective                                                                    |
| Build the internal AgentClient around ACP and wire provider events to ledger. |
+------------------------------+-----------------------------------------------+
| Work references              | Active workbenches                            |
| +------------+-------------+ | +--------+---------+----------+-------------+ |
| | GH#118     | open        | | | Codex  | editing | fedora-2 | Open native | |
| | JIRA-OC-77 | in review   | | | Claude | waiting | macbook  | claude.ai   | |
| | Prior task | archived    | | +--------+---------+----------+-------------+ |
| +------------+-------------+ | Actions: + Workbench  Request status Stop all |
+------------------------------+-----------------------------------------------+
| Tabs: Timeline | Context | Review | Diffs | Memory | Skills | Artifacts | Ledger |
+------------------------------------------------------------------------------+
| Timeline                                                                     |
| 10:13 Context generated from GH#118, 4 memory entries, AGENTS.md, skills     |
| 10:14 Codex launched on fedora-2 as mfox                                     |
| 10:22 File diff observed: packages/workbench/src/acpClient.ts                |
| 10:27 Claude requested approval: update provider policy routing              |
| 10:31 Tests running: npm test --workspace packages/workbench                 |
+------------------------------------------------------------------------------+
```

## New task and launch flow

Primary job: create a task from any work source and launch the right provider
under the right user.

```text
+------------------------------------------------------------------------------+
| New task                                                                     |
+------------------------------------------------------------------------------+
| 1 Objective                                                                  |
| +--------------------------------------------------------------------------+ |
| | Implement ACP event capture for workbench providers...                   | |
| +--------------------------------------------------------------------------+ |
|                                                                              |
| 2 Work references                                                            |
| [ JIRA-123        ] [ github.com/org/repo/issues/118 ] [ prior session v ]   |
|                                                                              |
| 3 Repositories                                                               |
| [ /home/mfox/OpenCortex-implementation ]  Base: main  Worktree: create new   |
|                                                                              |
| 4 Context                                                                    |
| [x] Include reviewed memory   [x] Include linked issue details   [x] Docs    |
| [x] Install selected skills   Bundle: OpenCortex agent baseline v            |
| [x] Include prior session summary        Policy: require plan before edits v |
|                                                                              |
| 5 Launch                                                                     |
| Provider: Claude Code v   Host: linux-macbook v   Linux user: ada v          |
| Auth: Ready          Worktree: /home/ada/opencortex-worktrees/acp-provider   |
|                                                                              |
|                                      Save Draft        Generate Context Pack |
|                                      Launch Workbench                        |
+------------------------------------------------------------------------------+
```

## Temporal session supervision

Primary job: understand whether OpenCortex can recover a session and whether a
human decision is required.

```text
+------------------------------------------------------------------------------+
| Session: Codex / ACP adapter                         Workflow: Recovering      |
+------------------------------------------------------------------------------+
| Provider process: Unknown     Host: fedora-2     Last heartbeat: 2m 14s ago  |
| Temporal workflow: Running    Run: 03f...        Launch attempt: 1 of 3       |
| Native session: codex_82      Workbench: wb_92   Last event: diff observed   |
+------------------------------------------------------------------------------+
| Recovery                                                                     |
| Host missed three heartbeats. Workflow is waiting on the fedora-2 task queue.|
| On reconnect it will reconcile wb_92 before reattaching or relaunching.       |
| No duplicate prompt or provider process will be created.                     |
+------------------------------------------------------------------------------+
| Request status     Move to replacement host...     Stop and archive           |
+------------------------------------------------------------------------------+
```

The workflow detail exposes orchestration status, provider process status,
review status, workflow/run ids, attempt count, last heartbeat, pending timer or
approval, and the next recovery decision. Raw Temporal history remains a
diagnostic link; the normalized OpenCortex timeline remains the user-facing
audit view.

Provider readiness detail:

```text
+------------------------------------------------------------------------------+
| Provider readiness                                                           |
+-------------+----------+--------------+--------------+-----------------------+
| Provider    | Host     | Linux user   | Status       | Action                |
+-------------+----------+--------------+--------------+-----------------------+
| Claude Code | macbook  | ada          | Ready        | Launch                |
| Codex       | macbook  | ada          | Login needed | Start device login    |
| OpenCode    | fedora-2 | mfox         | Ready        | Launch                |
+-------------+----------+--------------+--------------+-----------------------+
```

Skill readiness detail:

```text
+------------------------------------------------------------------------------+
| Skill bundle readiness                                                        |
+---------------------------+----------+--------------+--------------+---------+
| Bundle                    | Host     | Linux user   | Status       | Action  |
+---------------------------+----------+--------------+--------------+---------+
| Agent baseline            | macbook  | ada          | Installed    | Update  |
| Brain import review tools | macbook  | ada          | Not present  | Install |
| Repo workflow scripts     | fedora-2 | mfox         | Installed    | View    |
+---------------------------+----------+--------------+--------------+---------+
```

## Agents view

Primary job: supervise live provider sessions across hosts.

```text
+------------------------------------------------------------------------------+
| Agents                                                           Refresh  ... |
+------------------------------------------------------------------------------+
| Filters: State v  Provider v  Host v  Owner v  Needs action [ ]              |
+----+----------+--------------+------------+------------+---------+-----------+
| St | Provider | Task         | Host/User  | Worktree   | Last    | Action    |
+----+----------+--------------+------------+------------+---------+-----------+
| R  | Claude   | OIDC polish  | macbook/ada| oidc-google| 1m ago  | Open UI   |
| A  | Codex    | ACP adapter  | fedora/mfox| acp-client | 18s ago | Prompt    |
| !  | OpenCode | Host agent   | fedora/ada | host-agent | 12m ago | Logs      |
| ?  | Claude   | Ledger costs | macbook/mfx| ledger     | 4m ago  | Approve   |
+----+----------+--------------+------------+------------+---------+-----------+
```

Side panel:

```text
+-------------------------------------------------------+
| Codex / ACP adapter                                   |
+-------------------------------------------------------+
| State: editing                                        |
| Native session: cx_7f31...                            |
| ACP: connected                                        |
| Cost estimate: $7.80                                  |
| Current file: packages/workbench/src/acpClient.ts     |
| Pending: none                                         |
|                                                       |
| Open native UI   Attach terminal   Request status     |
| Pause            Stop              Hand off           |
+-------------------------------------------------------+
| Recent events                                         |
| 10:22 tool: read_file                                 |
| 10:23 diff: acpClient.ts                              |
| 10:27 model complete                                  |
+-------------------------------------------------------+
```

## Hosts view

Primary job: understand where work can run and why a launch can or cannot
start.

```text
+------------------------------------------------------------------------------+
| Hosts                                                            Enroll host  |
+------------------------------------------------------------------------------+
| Host scope: All       Show: capacity, auth, workers, services, failures       |
+--------------+---------+---------------+--------------+--------+-------------+
| Host         | Status  | Address       | Providers    | Agents | Last beat   |
+--------------+---------+---------------+--------------+--------+-------------+
| linux-macbook| online  | tailnet/local | Claude Codex | 5      | 14s ago     |
| fedora-2     | degraded| tailnet/local | OpenCode     | 2      | 31s ago     |
| builder-1    | offline | tailnet       | none         | 0      | 2h ago      |
+--------------+---------+---------------+--------------+--------+-------------+
```

Expanded host:

```text
+------------------------------------------------------------------------------+
| linux-macbook                                                                |
| Tailscale: 100.x.x.x    Local: 192.168.x.x    Worker: healthy                |
+------------------------------------------------------------------------------+
| Linux users                                                                  |
| +------+--------------+-------------+--------------+-----------------------+ |
| | User | OpenCortex   | Claude Code | Codex        | Worktree root         | |
| +------+--------------+-------------+--------------+-----------------------+ |
| | ada  | mapped       | ready       | login needed | /home/ada/...         | |
| | mfox | mapped       | ready       | ready        | /home/mfox/...        | |
| +------+--------------+-------------+--------------+-----------------------+ |
| Services: runtime ok, Temporal worker ok, Postgres ok, object store ok       |
+------------------------------------------------------------------------------+
```

## Review queue

Primary job: put every human decision in one place.

```text
+------------------------------------------------------------------------------+
| Review                                                              Mine v    |
+------------------------------------------------------------------------------+
| Required: 3       Changes requested: 1       Memory pending: 5       PRs: 2   |
+----+--------------+-------------+----------+--------------+-----------------+
| St | Request      | Task        | Kind     | Requested by | Action          |
+----+--------------+-------------+----------+--------------+-----------------+
| !  | Approve plan | ACP adapter | prompt   | Claude       | Review          |
| !  | Allow tool   | Host agent  | tool     | Codex        | Approve/Reject  |
| A  | PR review    | OIDC polish | pr       | OpenCortex   | Open diff       |
| ?  | Memory entry | Skill import| memory   | mfox         | Accept/Edit     |
+----+--------------+-------------+----------+--------------+-----------------+
```

Review detail:

```text
+------------------------------------------------------------------------------+
| Review request: Approve implementation plan                                  |
+------------------------------+-----------------------------------------------+
| Summary                      | Evidence                                      |
| Agent proposes to add ACP    | Context pack: cp_183                          |
| client events and ledger     | Work ref: GH#118                              |
| persistence before provider  | Files likely touched:                         |
| UI changes.                  | - packages/workbench/src                      |
|                              | - packages/activity-ledger/src                |
+------------------------------+-----------------------------------------------+
| Decision note                                                               |
| [ Require ledger event names to be provider-neutral...                     ] |
|                                                                              |
| Reject                    Request changes                    Approve          |
+------------------------------------------------------------------------------+
```

## Ledger and replay

Primary job: make the work auditable after the fact.

```text
+------------------------------------------------------------------------------+
| Ledger                                                       Export  Replay   |
+------------------------------------------------------------------------------+
| Scope: Task ACP adapter v     Events v     Provider v     Time range v        |
+----------+------------+-------------+--------------+------------+------------+
| Time     | Event      | Actor       | Provider     | Object     | Cost       |
+----------+------------+-------------+--------------+------------+------------+
| 10:13:02 | context    | mfox        | OpenCortex   | cp_183     |            |
| 10:14:11 | launched   | mfox/ada    | Claude Code  | wb_92      |            |
| 10:22:47 | diff       | Claude      | Claude Code  | acpClient  | $1.34 est  |
| 10:27:03 | approval   | mfox        | OpenCortex   | rr_44      |            |
| 10:31:50 | tests      | Codex       | Codex        | npm test   | $0.42 est  |
+----------+------------+-------------+--------------+------------+------------+
```

Replay view:

```text
+------------------------------------------------------------------------------+
| Replay: ACP adapter                                                          |
+------------------------------+-----------------------------------------------+
| Timeline                     | Detail                                        |
| * Context generated          | Rendered launch prompt                        |
| * Claude launched            | Work references                               |
| * Diff observed              | Memory entries used                           |
| * Approval requested         | Provider transcript excerpt                   |
| * Tests completed            | Diff/commit/PR links                          |
| * Summary archived           | Human review decisions                        |
+------------------------------+-----------------------------------------------+
```

## Memory view

Primary job: make durable knowledge usable and governable.

```text
+------------------------------------------------------------------------------+
| Memory                                                               + Capture|
+------------------------------------------------------------------------------+
| Search: [ provider-neutral ledger naming                         ]           |
| Filters: Scope v  Project v  Repo v  Task v  Review state v  Source v        |
+----+--------------+-------------+----------+-------------+------------------+
| St | Type         | Title       | Scope    | Source      | Used by          |
+----+--------------+-------------+----------+-------------+------------------+
| OK | decision     | ACP names   | project  | review      | 4 context packs  |
| A  | finding      | Dex issuer  | runtime  | session     | 1 context pack   |
| ?  | handoff      | Skills plan | task     | chat        | none             |
+----+--------------+-------------+----------+-------------+------------------+
```

Memory detail should show source event, source artifact, review state, citation
text, stale-risk flags, and affected tasks.

## Skills view

Primary job: manage installable agent capabilities from OpenCortex and imported
brain repository skills/scripts.

```text
+------------------------------------------------------------------------------+
| Skills                                                        Import  Publish |
+------------------------------------------------------------------------------+
| Search: [ test runner skill                                      ]           |
| Filters: Source v  Provider v  Type v  Review state v  Installed v           |
+----+----------------------+-------------+----------+-------------+-----------+
| St | Skill                | Source      | Type     | Providers   | Install   |
+----+----------------------+-------------+----------+-------------+-----------+
| OK | agent-baseline       | OpenCortex  | prompt   | generic     | 6 targets |
| A  | repo-test-runner     | brain import| script   | Claude Codex| 2 targets |
| !  | legacy-dsn-helper    | brain import| script   | unknown     | blocked   |
| ?  | jira-context-builder | brain import| workflow | generic     | review    |
+----+----------------------+-------------+----------+-------------+-----------+
```

Skill detail should show package files, checksums, branding/import notes,
required binaries, required environment variables, required MCP servers,
provider compatibility, install targets, validation status, and usage history.

Bundle builder:

```text
+------------------------------------------------------------------------------+
| Skill bundle: OpenCortex agent baseline                              Publish |
+------------------------------------------------------------------------------+
| Scope: project        Project: OpenCortex        Version: 2026.09.04          |
| Included skills: agent-baseline, repo-test-runner, jira-context-builder       |
| Install targets: linux-macbook/ada, fedora-2/mfox                             |
| Launch usage: attach to new Claude, Codex, and OpenCode sessions by default   |
| Actions: Validate dependencies   Install to targets   View ledger history     |
+------------------------------------------------------------------------------+
```

## Settings and governance

Primary job: keep policy visible without burying it in deployment files.

```text
+------------------------------------------------------------------------------+
| Settings                                                                     |
+---------------+--------------------------------------------------------------+
| Identity      | OIDC issuer: Google                                          |
| Users         | Dex bundled: enabled for local users                         |
| Hosts         | Linux user overrides: configured                             |
| Providers     |                                                              |
| Policies      | Provider policy routing                                      |
| MCP tools     | +--------------+--------------+--------------+------------+ |
| Retention     | | Policy       | Providers    | Tools        | Checkpoint | |
| Billing       | +--------------+--------------+--------------+------------+ |
|               | | default      | Claude Codex | approved MCP | plan,diff  | |
|               | | high-risk    | Codex only   | no network   | all tools  | |
|               | +--------------+--------------+--------------+------------+ |
| Skill bundles | baseline required, brain imports require review              |
+---------------+--------------------------------------------------------------+
```

## Operational state contract

Every asynchronously loaded region has its own state so one slow provider or
host does not blank or block the rest of the page:

| State | Required presentation | Required action |
|---|---|---|
| Initial loading | Skeleton matching the final layout and a concise label | None unless loading exceeds the timeout |
| Refreshing | Keep existing data visible; show region-level progress | Cancel when supported |
| Empty | Explain whether no records exist or filters hide them | Create, import, or clear filters |
| Partial | Identify the unavailable source and timestamp the available data | Retry only the failed source |
| Stale | Show last successful observation and staleness threshold | Refresh or inspect host/provider |
| Failed | Name the entity, likely cause, and retained user data | Retry, repair, or open diagnostics |
| Success | Confirm the outcome without moving focus | Undo when the action is reversible |

Async status messages use `role="status"`; blocking failures use `role="alert"`.
Refreshes do not steal focus. Destructive actions require confirmation that
names the affected task or session, while reversible changes offer undo.

## Mobile intent

Mobile should be useful for oversight and approvals, not full development.

```text
+----------------------+
| OpenCortex      mfox |
+----------------------+
| Needs attention      |
| +------------------+ |
| | Approve plan     | |
| | ACP adapter      | |
| | Claude / macbook | |
| | Review           | |
| +------------------+ |
| +------------------+ |
| | Codex editing    | |
| | Host: fedora-2   | |
| | Open native UI   | |
| +------------------+ |
| Tabs: Tasks Agents  |
+----------------------+
```

Mobile actions:

- approve/reject review requests;
- open provider-native mobile/web UI;
- request status;
- stop a runaway session;
- read handoff summaries;
- inspect host and auth health.

## Acceptance criteria

- A user can tell which agents are running across all hosts within one screen.
- A user can launch a provider session from a task without manually assembling
  issue context, repo context, memory context, skill bundles, and policy.
- A user can see whether a launch will fail because of host readiness, Linux
  user mapping, provider login, or worktree setup before clicking launch.
- A user can hand off a task with enough context for another operator to act.
- A user can replay what happened from context pack through provider events,
  human approvals, commits, PRs, memory, skill versions, and artifacts.
- A user can import, review, rebrand, package, publish, install, and audit skills
  from the old brain repository without confusing them with Memory.
- Jira remains useful but is visibly one work-reference adapter, not the system
  model.
- Claude, Codex, and OpenCode provider-native UIs remain the conversation
  surfaces where appropriate; OpenCortex supplies orchestration and oversight.
- Execution state and human review state are independently visible anywhere a
  user must decide what to do next.
- Every large table supports search or filtering, visible sorting, saved views,
  column control, an empty state, and expandable evidence or diagnostics.
- Every decision-driving value exposes its source and observation time; cost
  estimates identify their calculation basis.
- Every async region has loading, refreshing, empty, partial, stale, failed,
  and success behavior without blocking unaffected regions.
- All workflows are keyboard operable at 200% zoom with visible, unobscured
  focus, semantic headings, accessible names, and text labels for status.
- Launch failures preserve the user's task configuration and identify the exact
  provider, host, Linux user, failed check, and recovery action.
- Every workbench is owned by a durable Temporal workflow from preflight through
  archive; task workflows coordinate parallel or dependent child sessions.
- A worker restart or activity retry cannot duplicate a provider process or
  prompt, and recovery reconciles persisted process/session state first.
- Host outages leave workflows durably waiting and visibly recovering; moving a
  session to another host follows explicit policy and approval.
- Workflow histories contain opaque ids rather than provider credentials,
  authorization headers, secret environment values, or raw secret-bearing
  context.
