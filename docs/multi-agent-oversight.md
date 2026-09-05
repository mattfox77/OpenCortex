# Multi-agent oversight design

**Status:** design direction. Written 2026-09-02.

Wireframes: [multi-agent-oversight-wireframes.md](multi-agent-oversight-wireframes.md)
and [multi-agent-oversight-wireframes.html](multi-agent-oversight-wireframes.html).

OpenCortex should be a web-first control plane for distributed agent work. The
important product idea borrowed from Kepler is not a desktop agent launcher; it
is multi-agent oversight: knowing what every agent is doing, what work it is
attached to, what it changed, what it needs from a person, and whether it is
moving toward something mergeable.

Kepler proves the category. OpenCortex should push past its constraints:

- Kepler is primarily a local developer surface. OpenCortex is a web surface.
- Kepler organizes agents around local repos/worktrees. OpenCortex can organize
  agents across Tailscale-connected hosts, Linux users, worktrees, and provider
  UIs.
- Kepler focuses on delivery from issue/PR to merge. OpenCortex should add
  durable memory, identity, cross-host lifecycle, provider auth boundaries,
  session handoff, replay, cost attribution, and operational governance.

The thesis:

> OpenCortex is the operations layer for agentic software work across people,
> machines, providers, projects, and time.

## Goals

OpenCortex should let a user or team answer these questions from one web UI:

- Which agents are currently running?
- Which host and Linux user owns each process?
- Which task, issue, PR, repo, worktree, branch, and provider session does each
  agent belong to?
- Which sessions are waiting for approval, blocked, stale, expensive, failing,
  conflicting, or ready for review?
- What context was the agent given at launch?
- What did it change?
- Which commits, PRs, artifacts, memories, and decisions came from the session?
- Which provider UI should I open to inspect or steer it?
- Can I pause, resume, stop, hand off, relaunch, or archive it?

This is deliberately broader than "open a workbench". A workbench is one runtime
instance. Oversight is the inventory, control, and audit surface above all
workbenches.

## Existing OpenCortex assets to absorb

OpenCortex already contains most of the raw material for this design. The work is
less "build a new product from scratch" than "lift existing features into a
unified task, workbench, host, and ledger model."

| Existing feature | Current location | Role in oversight design |
|---|---|---|
| OIDC auth and Google-tested issuer support | `packages/runtime/src/auth`, `config/dex.example.yaml`, Dex deployment | User identity, owner/member roles, host access decisions, per-user provider credential boundaries |
| Linux user mapping and provisioning | `packages/runtime/src/system/provisioning.ts`, `packages/runtime/scripts/provision-opencortex-user.sh`, Temporal provisioning workflow | Converts authenticated people into local execution identities on each host |
| OpenCode workbench launch/proxy | `packages/workbench`, `packages/runtime/src/code/sessionLauncher.ts`, `/code/session/:id` proxy | First `WorkbenchProvider` implementation and compatibility layer for existing sessions |
| Session store and rename support | `packages/runtime/src/code/sessionStore.ts`, `CodeSession` | Migration seed for durable `Workbench` records |
| Session chat channels and membership | `packages/runtime/src/chat`, `packages/runtime/src/ui/public` | Collaboration surface, advisory review channel, event feed, and human context |
| Pair prompts and review gates | `packages/runtime/src/pairPrompts`, `packages/orchestrator/src/workflows/pairPrompt.ts` | Human approval workflow for agent prompts, checkpoints, and intervention |
| Jira tracking | `packages/runtime/src/jira`, `/work-tracking/jira-items`, `/code/sessions/:id/jira-links` | First `WorkReference` adapter and evidence model |
| Durable memory | `packages/memory`, `packages/runtime/src/memory`, `packages/cli` | Context retrieval, session summaries, decisions, findings, project memory, and replay support |
| Artifact storage and ingest workflows | `packages/orchestrator/src/workflows/memoryIngest.ts`, artifact activities, object store deployment | Stores original transcripts, generated artifacts, screenshots, logs, and context-pack attachments |
| Temporal workflows | `packages/orchestrator/src/workflows`, `packages/runtime/src/code/sessionLauncher.ts` workflow starters | Cross-host orchestration, durable launch/review/archive workflows, retries, and projections |
| Workflow projections | `packages/memory/migrations/013_workflow_projection.sql`, `packages/runtime/src/workflows` | Existing read model pattern for dashboard status and workflow inventory |
| Activity ledger package | `packages/activity-ledger` | Seed for normalized attribution, cost, model/tool events, and rollups |
| Metrics and tracing | `packages/runtime/src/http/metrics.ts`, `packages/orchestrator/src/telemetry.ts`, OpenTelemetry/Jaeger deploy profile | Operational visibility for hosts, workflows, sessions, provider events, and failures |
| Skills bundle publishing/provisioning | `packages/skills`, `packages/runtime/scripts/publish-skills.sh` | Distributes OpenCortex instructions and provider-specific behavior to Linux users and agents |
| CLI | `packages/cli` | Headless login, memory commands, status/report commands, future host/task operations |
| Podman Quadlet deployment | `deploy/podman-quadlet` | Local-first service substrate for runtime, Dex, Postgres, Temporal, objects, embeddings, telemetry |

The comprehensive design should preserve these pieces. Renaming and reshaping
the model is fine; replacing working subsystems wholesale is not.

## Non-goals

Do not build another Claude, Codex, or OpenCode UI. Use provider-native surfaces
where they are strong:

- Claude Code Remote Control and `claude.ai/code` for Claude conversation UX.
- Codex/Codex app surfaces where they give a better ChatGPT subscription-backed
  experience.
- OpenCode web where it is already useful.

OpenCortex owns orchestration, not provider identity. It should never extract
subscription tokens from provider credential stores. Provider credentials stay
per user and provider-owned.

Do not assume Jira is the center of work tracking. Jira is one adapter. The model
must also support Linear, GitHub Issues, GitLab Issues, Azure DevOps, Trello,
pull requests, documents, manually created tasks, and references to prior
OpenCortex sessions.

## Architectural principles

### Web control plane, local execution

The web runtime is the coordination surface. Agent code execution happens under
the selected Linux user on an enrolled host. This keeps credentials, checked-out
repositories, SSH keys, local tools, and private network access where they
already live while giving OpenCortex one browser-accessible oversight plane.

### Identity before process

Every launch starts with an authenticated OpenCortex user and resolves to:

- OpenCortex subject and email;
- tenant or organization;
- role on the task/workbench;
- target host;
- target Linux user;
- provider credential readiness for that Linux user.

This extends the existing OIDC plus `OPENCORTEX_LINUX_USER_OVERRIDES` behavior.
The same user may map to different Linux users on different hosts, but the
mapping must be explicit, auditable, and visible in the dashboard.

### Provider credentials stay provider-owned

OpenCortex can check that a provider appears configured, initiate sanctioned
login flows, and launch provider CLIs under the right user. It must not extract
Claude, Codex, OpenCode, or other provider subscription tokens from user homes.

### Everything important becomes an event

Provider logs are useful evidence, but they are not the system of record. Tasks,
work references, context packs, launches, prompts, approvals, diffs, commits,
PRs, memory captures, costs, and handoffs all need normalized events in the
ledger.

### Compatibility first, then vocabulary cleanup

The implementation should wrap current `CodeSession`, Jira, chat, and workflow
features behind generic names before deleting old route names or storage shapes.
This avoids breaking the working local deployment while the product model is
being raised one level.

## Core model

### AgentTask

`AgentTask` is the top-level unit of desired work. It is independent of project
management systems and may span several repositories and provider sessions.

Fields:

- `id`
- `title`
- `objective`
- `status`: `draft`, `planning`, `running`, `waiting`, `review`, `blocked`,
  `done`, `archived`, `failed`
- `owner`
- `members`
- `project`
- `topic`
- `priority`
- `createdAt`, `updatedAt`, `archivedAt`
- `workReferences[]`
- `repositories[]`
- `worktrees[]`
- `contextPackId`
- `policy`
- `providerSessions[]`
- `chatChannelId`
- `workflowProjectionIds[]`
- `artifactIds[]`
- `memoryEntryIds[]`
- `pullRequests[]`
- `activitySummary`
- `costSummary`

The task is what the dashboard groups by. Workbenches, provider sessions,
worktrees, PRs, and memories hang off it.

Existing feature absorption:

- Session chat becomes the task/workbench collaboration channel.
- Pair prompts become task-scoped prompt approval requests.
- Workflow projections become task status/read-model entries.
- Memory entries and artifacts attach to the task as durable context and output.

### WorkReference

`WorkReference` generalizes the existing Jira session link feature. Jira becomes
the first adapter, not the domain model.

Fields:

- `id`
- `taskId`
- `workbenchId`
- `provider`: `jira`, `linear`, `github`, `gitlab`, `azure-devops`, `trello`,
  `pull-request`, `document`, `manual`, `opencortex`
- `kind`: `issue`, `epic`, `task`, `bug`, `pull-request`, `document`, `session`,
  `team`, `project`
- `externalId`
- `key`
- `url`
- `title`
- `description`
- `status`
- `team`
- `project`
- `labels`
- `source`: `manual`, `chat-message`, `task-create`, `provider-sync`,
  `agent-output`, `review`
- `confidence`: `manual`, `explicit`, `inferred`
- `evidenceRef`
- `cachedAt`

Existing Jira APIs should migrate toward this generic surface:

| Current | Target |
|---|---|
| `JiraSessionLink` | `WorkReference` |
| `/work-tracking/jira-items` | `/work-tracking/items?provider=jira` |
| `/code/sessions/:id/jira-links` | `/workbenches/:id/work-references` |
| `jiraLinks.updated` | `workReferences.updated` |
| Jira issue/team cache | provider-specific work item cache |

The current Jira parser, local event log, item/team cache, session search, item
details, source counts, and evidence references should all survive. The generic
adapter boundary should preserve the parts that made Jira tracking valuable:

- references can be attached manually;
- references can be inferred from chat text;
- references can be enriched from a provider;
- sessions/tasks can be searched by reference;
- item detail pages show related sessions, evidence, source counts, and a
  formatted context block agents can consume.

### Workbench

`Workbench` is one running provider instance for a user on a host.

Fields:

- `id`
- `taskId`
- `providerId`: `claude-code`, `codex`, `opencode`, future providers
- `providerVersion`
- `ownerEmail`
- `linuxUser`
- `hostId`
- `workspaceDir`
- `worktreeId`
- `status`: `launching`, `running`, `waiting`, `stopped`, `failed`, `archived`
- `launchCommand`
- `environmentSummary`
- `startedAt`, `lastActivityAt`, `stoppedAt`
- `providerSessionId`
- `providerUrl`
- `providerFallbackUrl`
- `logPath`
- `terminalAttachUrl`
- `activityCursor`
- `chatChannelId`
- `pairPromptPolicy`
- `reviewState`
- `workflowId`, `workflowRunId`
- `orchestrationStatus`: `scheduled`, `starting`, `supervising`, `recovering`,
  `waiting`, `stopping`, `completed`, `failed`
- `launchAttempt`
- `recoveryPolicy`

The existing `CodeSession` record is the migration seed for this. The current
one-session-per-user behavior is not enough for multi-agent oversight; the id
must stop being a pure function of Linux user and become a durable workbench id.

Current OpenCode proxy behavior remains a compatibility mode. New provider
launches should prefer opening provider-native surfaces in new tabs, with
OpenCortex storing the link and monitoring state from the side.

### ProviderSession

`ProviderSession` stores the provider's native conversation/process identifier.

Examples:

- `openCodeSessionId`
- `claudeCodeSessionId`
- Codex session id
- ACP session id

Fields:

- `id`
- `workbenchId`
- `providerId`
- `nativeSessionId`
- `remoteControlUrl`
- `resumeCommand`
- `startedAt`
- `lastEventAt`
- `state`
- `costCursor`
- `eventCursor`

Provider sessions are where ACP, Claude Remote Control, Codex sessions, and
OpenCode internal session ids meet the OpenCortex model. If a provider exposes a
native deep link, store it here. If it only exposes logs or a local port, store
the best available attach path and mark the capability explicitly.

### Host

`Host` represents a machine capable of running provider workbenches.

Fields:

- `id`
- `name`
- `tailscaleName`
- `tailscaleIp`
- `localIps[]`
- `status`: `online`, `degraded`, `offline`
- `lastHeartbeatAt`
- `agentVersion`
- `capabilities`
- `providers[]`
- `linuxUsers[]`
- `capacity`
- `labels`

Capabilities include available binaries, versions, supported launch modes,
whether the host can create worktrees, whether it has Temporal worker access,
and which provider auth states are satisfied per Linux user.

The first host registry can be built from data OpenCortex already has:

- the runtime host is known from deployment config;
- Temporal workers can heartbeat as host executors;
- provisioning knows which Linux users exist or can be created;
- readiness checks already validate Postgres and other local services;
- provider launch failures already reveal missing binaries and auth problems.

Do not wait for a perfect daemon before exposing host status. Start with runtime
and worker heartbeats, then add a dedicated host agent if direct control needs
outgrow Temporal.

### ContextPack

`ContextPack` is the generated launch brief given to a provider session.

Fields:

- `id`
- `taskId`
- `createdAt`
- `createdBy`
- `objective`
- `repositories`
- `workReferences`
- `memoryReferences`
- `skillBundleReferences`
- `priorSessionReferences`
- `instructions`
- `policy`
- `renderedPrompt`
- `attachments`
- `renderers`
- `sourceEventIds`

Every provider launch should record the exact context pack used. This makes
session replay, audit, cost attribution, and quality review possible later.

OpenCortex memory should be the context pack's durable knowledge source. The
builder should retrieve approved or explicitly requested pending entries by
project, repo, owner/team/global scope, work reference, and prior session. The
rendered pack should cite which memory entries and artifacts it used so stale or
wrong context can be debugged later.

Skill bundles are separate from memory. A context pack can request or activate
skills, but the skill content itself is managed by the Skill Library and
installed into the selected host/Linux user before provider launch.

### ChatChannel

The current chat system should become the human collaboration layer for tasks and
workbenches.

Fields:

- `id`
- `taskId`
- `workbenchId`
- `type`: `task`, `workbench`, `project`, `global`
- `members`
- `messages`
- `systemEvents`
- `workReferenceMentions`
- `pairPromptDrafts`

Chat is not just comments. It is a source of evidence and intent:

- Jira/work-reference mentions in chat create or suggest `WorkReference` links.
- Pair-prompt drafts originate from chat or review discussion.
- Agent status summaries can be posted back into the channel.
- Handoff summaries can be generated from recent chat plus ledger events.

### ReviewRequest

The current pair-prompt workflow is a specialized review request. Generalize it.

Fields:

- `id`
- `taskId`
- `workbenchId`
- `kind`: `prompt`, `tool`, `diff`, `commit`, `pr`, `handoff`, `memory`
- `requestedBy`
- `reviewers`
- `status`: `draft`, `ready`, `approved`, `rejected`, `changes_requested`,
  `cancelled`
- `summary`
- `payload`
- `decision`
- `workflowId`
- `createdAt`, `decidedAt`

Existing pair prompts map to `kind=prompt`. Memory review maps to `kind=memory`.
Future ACP permission requests map to `kind=tool` or `kind=diff` depending on
what the agent asks to do.

### MemoryEntry and Artifact

OpenCortex already has durable memory, review states, artifacts, chunks,
embeddings, and CLI access. Multi-agent oversight should treat them as first
class task assets.

Memory roles:

- launch context retrieval;
- session summaries;
- durable decisions and findings;
- PR/review rationale;
- handoff packets;
- replay annotations;
- reusable team/project knowledge.

Artifact roles:

- original transcripts;
- generated files that are not committed;
- screenshots;
- logs;
- context-pack attachments;
- PR review exports;
- replay bundles.

The current artifact ingest workflow already stores originals, extracts text,
chunks content, embeds it, writes memory entries, and creates audit/projection
records. Reuse that path for session archival and replay instead of creating a
second transcript store.

### SkillPackage and SkillBundle

The old brain repository's collection of skills and scripts should become the
OpenCortex Skill Library. This is related to the "brain" history, but it is not
the same thing as Memory.

Definitions:

- `MemoryEntry`: durable knowledge an agent can cite or reuse.
- `SkillPackage`: an installable capability, prompt, script, MCP config,
  provider instruction, workflow helper, or setup utility.
- `SkillBundle`: a selected set of skill packages attached to a task, project,
  provider, host, or Linux user.

`SkillPackage` fields:

- `id`
- `name`
- `displayName`
- `description`
- `source`: `opencortex`, `brain-import`, `manual`, `git`, `artifact`
- `version`
- `status`: `draft`, `ready`, `deprecated`, `blocked`
- `providerCompatibility[]`: `claude-code`, `codex`, `opencode`, `generic`
- `requiredBinaries[]`
- `requiredEnvironment[]`
- `requiredMcpServers[]`
- `installScript`
- `activationInstructions`
- `files[]`
- `checksum`
- `importNotes`
- `createdAt`, `updatedAt`

`SkillBundle` fields:

- `id`
- `name`
- `scope`: `global`, `tenant`, `project`, `task`, `workbench`, `host`, `user`
- `skillPackageIds[]`
- `policy`
- `installedTargets[]`
- `lastPublishedAt`
- `lastValidatedAt`

The brain repository import should produce OpenCortex-branded `SkillPackage`
records and installable artifacts. Migration work should:

- inventory every brain skill/script;
- remove BrainTrust/brain branding from names, descriptions, prompts, and paths;
- classify each item as prompt, script, MCP config, provider instruction,
  workflow helper, setup helper, or deprecated;
- record provider compatibility and required binaries/environment variables;
- package files with checksums;
- generate install and validation metadata;
- publish a bundle that can be installed into selected Linux users;
- write ledger events for import, review, publish, install, and use.

The skill system itself is core OpenCortex functionality. Only the cleanup and
migration of legacy brain skills is deferred until the imported content is
reviewed and rebranded.

## ACP decision

Adopt Agent Client Protocol (ACP) as the default provider control plane.

MCP is for tools: agents use it to reach services and local capabilities. ACP is
for orchestration: OpenCortex uses it as the client-side protocol for starting
agent work, sending prompts, receiving streaming updates, showing diffs, handling
permission requests, and recording session state.

OpenCortex should use two separate interfaces:

| Interface | Scope |
|---|---|
| `WorkbenchProvider` | Launch and lifecycle: command, env, user, cwd, worktree, URL, process supervision |
| `AgentClient` | Agent interaction: ACP session, prompt delivery, events, diffs, approvals, stop/resume |

Provider stance:

- Claude Code: ACP for orchestrated execution where possible; Remote Control for
  the provider-native web/mobile UX.
- Codex: ACP/Codex CLI preferred for task execution; codexapp can remain a
  transitional provider UI.
- OpenCode: keep current web path until the selected runtime has a usable ACP
  adapter.

Do not block the task/work-reference migration on ACP. The generic task model is
valuable immediately, and ACP can enrich provider telemetry adapter by adapter.

## Web-first dashboard

The primary OpenCortex UI should be an operations console, not a single embedded
workbench.

### UX operating standard

The console is optimized for five expert-user jobs: monitor distributed work,
triage exceptions, review evidence, intervene safely, and reconstruct what
happened. Visual simplicity must not hide status, provenance, policy, cost, or
the next required action.

The default dashboard is an attention queue, not a wall of aggregate metrics.
Failures, blocked launches, approvals, stale sessions, policy violations, and
budget exceptions appear before healthy work and sort by urgency. Summary
metrics route to filtered records. They never replace the task, review, host,
or ledger detail needed to make a decision.

Required interaction patterns:

- show execution state separately from reviewer/approval state;
- keep current tenant, project, owner, host scope, filters, sort, and saved view
  visible;
- put the next safe action beside the task, session, review, or host it affects;
- preserve user input after validation, preflight, or launch failure;
- use progressive disclosure for raw identifiers, logs, event payloads, and
  advanced policy while keeping evidence and exceptions immediately reachable;
- refresh regions independently, retain the last usable data, display its age,
  and announce material async results without stealing focus;
- show explicit loading, empty, partial, stale, failed, and success states;
- support search, visible sorting, filters, saved views, column selection,
  sticky headers, row expansion, and compact density on large operational tables;
- show source, observed-at time, confidence or estimation basis, and reviewer
  history for values used in approvals, policy, memory, and cost decisions.

Accessibility baseline is WCAG 2.2 AA. Every control requires an accessible
name, every field a persistent label, every status a text equivalent, and every
workflow a logical keyboard path with visible and unobscured focus. Authentication
must not depend on a cognitive function test. Hover-only content must also work
with keyboard focus and remain dismissible, hoverable, and persistent.

The implementation should use semantic HTML before ARIA, with `role="status"`
for non-blocking updates, `role="alert"` for blocking failures, and focus moved
only when required to recover from an error or enter a user-requested dialog.
Destructive operations require named confirmation; reversible changes should
offer undo.

Standards and pattern references:

- [W3C Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/)
- [W3C error identification guidance](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html)
- [W3C focus appearance guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html)
- [IBM Carbon data table usage](https://carbondesignsystem.com/components/data-table/usage/)
- [IBM Carbon data table accessibility](https://carbondesignsystem.com/components/data-table/accessibility/)
- [Nielsen Norman Group data-table user tasks](https://www.nngroup.com/articles/data-tables/)
- [Nielsen Norman Group progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)

Top-level views:

- **Tasks:** grouped by project, owner, state, priority, due date, and work
  reference provider.
- **Agents:** every active provider session across all hosts.
- **Hosts:** enrolled machines, health, capacity, provider readiness, active
  workbenches.
- **Review:** sessions with pending approvals, diffs, PR feedback, test failures,
  or merge decisions.
- **Ledger:** usage, cost, model/tool events, commits, PR attribution, archived
  context packs.
- **Memory:** task-linked findings, decisions, summaries, and reusable context.
- **Skills:** installable agent capabilities, brain imports, provider
  compatibility, host/user installation state, and validation results.

Agent/session list columns:

- status
- provider
- host
- owner
- task
- work references
- repo/worktree
- branch
- last activity
- pending action
- cost estimate
- provider link
- actions

Actions:

- open provider UI
- attach terminal/log viewer
- pause
- resume
- stop
- relaunch
- ask for status
- send follow-up prompt
- request plan
- request tests
- request PR
- archive
- hand off to another user

## Cross-host execution

OpenCortex should run sessions on any enrolled host, not only the web server.

The initial implementation can use Temporal workers as the host agents:

1. Each host runs an OpenCortex worker process.
2. The worker registers host metadata and heartbeats.
3. Runtime schedules a launch workflow to the selected host/task queue.
4. Worker provisions or validates the Linux user.
5. Worker creates the worktree and context pack materialization.
6. Worker launches the provider process.
7. Worker streams ACP/provider events and process health back to runtime.

This fits the current architecture better than inventing a second RPC layer
immediately. Later, a dedicated lightweight host agent can replace or complement
Temporal workers if direct online control is needed.

Host selection policy:

- explicit user choice first;
- otherwise prefer hosts where the owner has provider auth already configured;
- then prefer hosts with the repository already cloned;
- then capacity and health;
- then label constraints such as `gpu`, `macos`, `linux`, `customer-vpn`, or
  `high-trust`.

Tailscale gives OpenCortex a practical deployment boundary: hosts can be private,
addressable, and identity-aware without exposing raw provider ports publicly.

## Durable agent-session orchestration

Every managed agent workbench should be supervised by Temporal for its complete
lifecycle, not only launched through a short workflow. Temporal makes the
control state, timers, approvals, retries, and recovery decisions durable. It
does not make the provider process itself durable: Claude Code, Codex, or
OpenCode still runs on the selected host under the selected Linux user.

Use a two-level workflow hierarchy:

```text
AgentTaskWorkflow (one per AgentTask)
  +-- AgentSessionWorkflow (one per Workbench)
  +-- AgentSessionWorkflow (another provider or parallel attempt)
  +-- ReviewRequestWorkflow (durable human checkpoint)
  +-- ArchiveSessionWorkflow (artifacts, summary, memory, replay)
```

`AgentTaskWorkflow` coordinates task-level policy, membership, budgets,
cross-agent dependencies, reviews, handoff, completion, and archival. Each
`AgentSessionWorkflow` owns exactly one workbench lifecycle:

1. Resolve task, policy, context-pack version, host, Linux user, and provider.
2. Run launch preflight and wait durably for repair if readiness is blocked.
3. Materialize the worktree, context pack, and selected skill bundle.
4. Start or reconcile the provider process using the stable workbench id as the
   idempotency key.
5. Capture the provider-native session id and deep link when available.
6. Supervise process health and ingest ACP/provider events.
7. Wait on Temporal signals or updates for prompt, pause, resume, approval,
   handoff, stop, relaunch, or archive commands.
8. Recover by reconciling host process state before deciding whether to
   reattach, resume the native provider session, or launch a replacement.
9. Archive transcript, events, artifacts, summary, memory candidates, cost, and
   the final worktree state.

### Reliability boundaries

Temporal retries apply to activities, not blindly to provider launches. Every
side-effecting activity must be idempotent:

- `EnsureExecutionUser` and worktree preparation reconcile desired state.
- `StartProviderProcess(workbenchId)` first looks up the persisted process and
  provider-session record. A retry reattaches when the process exists.
- `SendPrompt(commandId)` deduplicates by command id so workflow replay or
  activity retry cannot submit a prompt twice.
- `StopProviderProcess(commandId)` is safe when the process already exited.
- artifact, ledger, and projection writes use deterministic event/idempotency
  keys.

Long-running process supervision uses heartbeating activities or short polling
activities separated by durable timers. A worker crash causes Temporal to
retry the activity. A host outage leaves the workflow durably waiting on that
host's task queue; it does not redirect a process launch to another host unless
policy and a user-approved recovery path allow it.

Classify failures before retrying:

| Failure | Default behavior |
|---|---|
| Transient runtime/network/database error | Retry with bounded exponential backoff |
| Worker restart after process launch | Reconcile by workbench id; reattach before relaunch |
| Host offline | Mark recovering, wait for heartbeat, then reconcile |
| Provider auth missing/expired | Do not retry; wait for user remediation |
| Invalid repo, policy, or context | Do not retry; expose correction action |
| Provider process exited unexpectedly | Resume or relaunch within policy and attempt budget |
| Budget or approval boundary reached | Wait durably for authorized decision |
| Explicit stop/archive | Cancel activities cooperatively, persist final state, archive |

The dashboard must show Temporal orchestration state separately from provider
process state. For example, a workflow can be `recovering` while the last known
provider process is `unknown`, or the workflow can be `waiting` while Claude is
healthy but blocked on approval.

### Workflow evolution and security

- Use deterministic workflow ids such as `task/<taskId>` and
  `workbench/<workbenchId>` so duplicate API requests return the existing
  workflow rather than creating duplicate sessions.
- Use Temporal Updates for synchronous commands that need accepted/rejected
  results, Signals for asynchronous intent, and Queries/read-model projections
  for status.
- Use child workflows for independently retryable sessions and archival work.
- Use `continueAsNew` after a configured event/history threshold while carrying
  only compact durable state and correlation ids.
- Pin or deliberately upgrade worker versions so in-flight workflow history
  remains replayable as orchestration code changes.
- Do not place provider credentials, OIDC tokens, runtime authorization headers,
  raw prompts containing secrets, or secret environment values in workflow
  inputs, memo, search attributes, results, or errors because Temporal retains
  workflow history. Store immutable context packs and secrets in their approved
  stores and pass opaque ids to activities.
- Persist normalized business events to the OpenCortex activity ledger. Temporal
  history is orchestration evidence and a recovery mechanism, not the product's
  long-term query or billing ledger.

The existing `WorkbenchSessionWorkflow` is the compatibility scaffold for this
design. It should evolve from a bounded `maxProbeIterations` launch/probe loop
into the durable `AgentSessionWorkflow`; existing stop/archive/attach/prompt
signals should remain compatible while generic command names and Temporal
Updates are added.

## Worktree management

Each task/repo/provider run should have an isolated worktree unless the user
explicitly asks to work in an existing checkout.

Worktree fields:

- `id`
- `taskId`
- `hostId`
- `linuxUser`
- `repoUrl`
- `baseBranch`
- `branch`
- `path`
- `status`
- `createdAt`
- `lastTouchedAt`
- `cleanupPolicy`

Default path:

```text
/home/<linuxUser>/opencortex-worktrees/<task-slug>/<repo-slug>
```

Default branch:

```text
opencortex/<task-key-or-slug>/<provider>/<short-id>
```

Track:

- base branch and current HEAD
- dirty files
- untracked files
- commits created
- conflicts
- rebase status
- PR link
- cleanup eligibility

Cleanup should be explicit at first. Later, automate cleanup when a task is
archived, a PR is merged, or a worktree has been stale for a configured period.

## Context-pack builder

The context-pack builder is the practical bridge between work tracking and
provider launch.

Inputs:

- task objective
- work references and provider-enriched metadata
- selected repos and worktrees
- relevant memory entries
- referenced sessions/workbenches
- project instructions
- repo instructions such as `CLAUDE.md`, `AGENTS.md`, `.github/copilot-*`,
  README, test commands, and contribution docs
- policy constraints
- user preferences

Output:

- rendered prompt
- files or attachments placed in the worktree
- provider-specific launch flags
- expected checkpoints

The builder should have a stable generic shape and provider renderers:

- Claude Code renderer: concise first prompt plus optional `--add-dir`,
  `--mcp-config`, `--settings`, `--permission-mode`, `--name`, `--session-id`,
  and Remote Control metadata.
- Codex renderer: prompt plus Codex sandbox/approval policy and worktree.
- OpenCode renderer: prompt or session creation call where available.

Every context pack should be immutable after launch. Follow-up prompts create
new activity events, not retroactive changes to the launch context.

## State and status model

The oversight dashboard needs a normalized session state, independent of provider
wording.

Recommended states:

- `draft`: task exists but no agent launched.
- `queued`: launch requested, waiting for host capacity.
- `launching`: host is preparing user, worktree, and provider process.
- `running`: provider is active.
- `thinking`: provider reports active model work.
- `editing`: provider is changing files.
- `waiting_for_approval`: provider requested human approval.
- `waiting_for_input`: provider asked a question or needs direction.
- `blocked`: provider cannot proceed.
- `review_ready`: changes exist and need review.
- `tests_running`: tests or CI are running.
- `pr_open`: PR exists.
- `merged`: work reached target branch.
- `stopped`: process stopped intentionally.
- `failed`: process or workflow failed.
- `archived`: hidden from active operations.

Providers can emit richer events; OpenCortex maps them to these states for
dashboard consistency.

## Activity ledger

The activity ledger should become the durable audit spine.

Capture:

- task created/updated/archived
- work reference attached/removed/enriched
- context pack generated
- worktree created/updated/cleaned
- provider process launched/stopped/failed
- ACP session initialized
- prompt sent
- model started/completed
- tool call started/completed/failed
- permission requested/approved/rejected
- file diff observed
- tests started/completed
- commit created
- PR opened/updated/merged
- provider URL/deep link captured
- handoff requested/accepted/completed
- cost/token usage observed or estimated

Each event should carry:

- `taskId`
- `workbenchId`
- `providerSessionId`
- `hostId`
- `actorId`
- `providerId`
- `repo`
- `worktreeId`
- `correlationId`
- `timestamp`
- `payload`

This makes session replay and attribution possible without treating provider logs
as the source of truth.

Existing absorption:

- `packages/activity-ledger` remains the ledger package, but its schema needs to
  move from coarse rollups toward append-only normalized events.
- Temporal workflow starts, completions, retries, and failures become ledger
  events with the Temporal `workflowId` as a correlation id.
- Chat messages, Jira/work-reference changes, pair-prompt decisions, memory
  reviews, artifact ingests, and workbench lifecycle changes should all publish
  ledger events through one runtime service boundary.
- Existing rollups become projections over the ledger instead of separate
  facts. Keep the ability to compute by `sessionId` during migration, then add
  `taskId`, `workbenchId`, and `providerSessionId`.

## Cost and value tracking

Kepler plus GitKraken Insights points at a useful feedback loop: developers need
to know which agent work is worth its cost.

OpenCortex should track:

- cost by task, provider, model, repo, owner, and PR;
- turns/prompts by task and provider;
- tool failures and rate limits;
- cache/context reuse where providers expose it;
- elapsed wall time and active model time;
- human interruptions and approvals;
- success outcomes: merged, abandoned, reverted, review changes requested.

Exact cost is preferable where a provider exposes it. Estimated cost is still
useful if clearly labeled. The key is attribution: a PR should show which agent
sessions and context packs contributed to it.

## Review and intervention

Oversight only matters if a person can act.

OpenCortex should support:

- status request: ask an agent to summarize where it is;
- plan checkpoint: require a plan before implementation;
- approval checkpoint: approve or reject risky tool actions;
- diff checkpoint: review changes before commit;
- test checkpoint: require tests before PR;
- PR checkpoint: require human approval before opening/updating a PR;
- stop/pause/resume;
- relaunch from same context pack;
- hand off ownership or reviewer role;
- attach another provider session to the same task.

The first version can implement these as explicit buttons and chat commands.
Later, task policies can automate them.

## Handoff and collaboration

OpenCortex should support session handoff between users.

Handoff is not just sharing a URL. It should transfer operational context:

- task objective;
- current state;
- host and worktree;
- provider session link;
- recent summary;
- pending actions;
- risk notes;
- related work references;
- latest diff/PR;
- relevant memory.

Roles:

- owner: can stop, archive, approve, hand off, and change policy;
- operator: can prompt, pause/resume, open provider UI, and attach evidence;
- reviewer: can inspect, comment, approve checkpoints;
- observer: read-only visibility.

Provider-native UIs may not enforce these roles. OpenCortex can still enforce
them around launch, links, logs, prompts sent through ACP, reviews, and workflow
actions.

## Identity and provider auth

The existing OIDC implementation is the system identity layer. Dex remains
bundled for local installs, and Google is the second compliant issuer used for
real OIDC validation. Multi-agent oversight should not add a second auth model.

Identity flow:

1. Browser user signs in through OIDC.
2. Runtime resolves the OpenCortex subject, email, tenant, and roles.
3. Runtime resolves the target host and Linux user mapping.
4. Runtime checks provider readiness for that Linux user.
5. Launch workflows run only under that Linux user.
6. Ledger events record the OpenCortex actor and the execution identity.

Provider auth readiness must stay observational. For example, OpenCortex can run
provider-supported status commands under `sudo -n -H -u <linuxUser>` or inspect
whether a sanctioned login flow completed, but it must not read subscription
tokens or copy credentials between users.

Current per-user auth work becomes the basis for:

- provider readiness badges in the host and workbench launch UI;
- guided login actions for Claude Code, Codex, and OpenCode;
- policy checks that block launching a provider where the selected user is not
  authenticated;
- audit records showing who launched which provider as which Linux user.

## Runtime and API shape

The runtime should become the control-plane API for tasks, workbenches, hosts,
work references, reviews, memory, artifacts, and ledger views.

Existing route families should migrate as follows:

| Current surface | Target surface |
|---|---|
| `/code/session/:id` | `/workbenches/:id/open` or provider-specific attach URL |
| `/code/sessions` | `/workbenches` plus `/tasks/:id/workbenches` |
| `/code/sessions/:id/jira-links` | `/workbenches/:id/work-references` |
| `/work-tracking/jira-items` | `/work-tracking/items` with provider filters |
| Pair-prompt APIs | `/review-requests` |
| Memory capture/search APIs | Keep, add task/workbench/work-reference filters |
| Workflow projection APIs | Keep, add task/workbench/host filters |
| Metrics endpoint | Keep, add task/provider/host counters |

Do this with additive routes and compatibility adapters first. UI components can
move to the new vocabulary while old routes remain available for one release.

## Temporal workflow absorption

Temporal is already the right durable execution substrate. The oversight design
should extend current workflows instead of introducing an unrelated job system.

Mapping:

| Current workflow/activity area | Target responsibility |
|---|---|
| Workbench session | `AgentSessionWorkflow`: preflight, launch/reconcile, supervise, command, recover, stop, archive |
| Task workflow | `AgentTaskWorkflow`: coordinate child sessions, policy, budget, dependencies, reviews, handoff, completion |
| User provisioning | `EnsureExecutionUser`: host-local user readiness and directory permissions |
| Pair prompt | `ReviewRequest(kind=prompt)`: prompt approval lifecycle |
| Memory ingest | `ArchiveSession`: transcript/artifact capture, extraction, embedding, review state |
| Artifact sync | `SyncTaskArtifacts`: generated outputs, screenshots, logs, context attachments |
| Activity rollup | `LedgerProjection`: cost, model/tool, PR, provider, and task rollups |
| Workflow projection | Dashboard read model for task/workbench/host workflow state |

The first cross-host design can assign one Temporal task queue per enrolled host
or host class. A later host daemon can improve direct control, but it should
still report durable lifecycle events into the same workflow and ledger model.
The runtime API starts, signals, updates, and queries these workflows; it must
not independently mutate a provider session in ways the owning workflow cannot
observe and reconcile.

## Memory and replay

OpenCortex memory should become the shared, reviewed knowledge layer behind
multi-agent work. It should not be limited to generic notes.

Task-linked memory types:

- `launch_context`: what was intentionally given to the agent;
- `session_summary`: what happened and what changed;
- `decision`: architectural or product decision made during the session;
- `finding`: bug, risk, or investigation result;
- `handoff`: concise packet for another operator;
- `review`: human review outcome;
- `replay_annotation`: note attached while replaying a session.

Replay should be generated from:

- immutable context packs;
- normalized ledger events;
- provider transcript artifacts;
- diffs, commits, and PR links;
- chat and review decisions;
- memory entries created during or after the session.

The replay view can start as a chronological event stream with filters. Later it
can add reconstructed prompts, file timelines, and side-by-side context versus
output comparison.

## Skill Library

The Skill Library should be a first-class product area, not a hidden deployment
script. It answers:

- which skills and scripts are available;
- which ones came from the old brain repository;
- which ones are reviewed, rebranded, deprecated, or blocked;
- which providers can use each skill;
- which hosts and Linux users have each bundle installed;
- which tasks and sessions used each skill version;
- which binaries, environment variables, MCP servers, or permissions are
  required.

Primary Skill Library screens:

- Inventory: searchable table of skills, source, type, version, compatibility,
  review state, and install state.
- Import review: brain repository import findings, branding issues, required
  edits, checksums, and packaging results.
- Bundle builder: select skills for global, tenant, project, task, provider,
  host, or user scope.
- Installation targets: publish/install bundles to selected host/Linux-user
  pairs.
- Usage history: ledger-derived view of tasks, workbenches, and providers that
  used each skill version.

Skill installation should happen before provider launch and should be visible in
the launch readiness checklist. A provider session should record the exact skill
bundle versions available at launch, just as it records the context pack.

## CLI and skills

The CLI should become the headless operator interface for the same control plane.

Near-term commands:

- `cortex tasks list`
- `cortex tasks show <id>`
- `cortex workbenches list`
- `cortex workbenches launch`
- `cortex workbenches stop <id>`
- `cortex hosts list`
- `cortex memory search --task <id>`
- `cortex skills list`
- `cortex skills import --source brain`
- `cortex skills publish <bundle>`
- `cortex skills install <bundle> --host <host> --user <linuxUser>`
- `cortex ledger tail --task <id>`

The skills package should distribute OpenCortex provider instructions and
project conventions into each execution user. Existing skill publishing and
provisioning can support:

- global OpenCortex operating rules;
- provider-specific launch instructions;
- project-specific context builders;
- migration of imported BrainTrust skills into OpenCortex naming and branding;
- host/user setup validation.

Do not defer the skill system. Defer only the migration of existing BrainTrust
skills that require cleanup or OpenCortex rebranding before import.

## Deployment topology

The current Podman Quadlet deployment is a good local-first target and should be
the reference topology for the first oversight release.

Core services:

- runtime web/API service;
- Postgres memory/control database;
- Temporal server and workers;
- Dex for bundled local OIDC;
- object store for artifacts;
- embedding service;
- metrics/tracing stack;
- optional provider-specific local services such as OpenCode.

Network posture:

- expose OpenCortex through local IP and Tailscale IP;
- bind raw provider ports to loopback unless intentionally proxied;
- prefer provider-native secure URLs for Claude/Codex hosted surfaces;
- use Tailscale identity and private addressing for enrolled hosts.

This makes the single-machine install useful immediately while leaving the same
architecture ready for additional hosts.

## Security and governance

Security boundaries:

- Provider credentials stay in the target Linux user's home.
- OpenCortex must not read or centralize Claude, Codex, or OpenCode subscription
  tokens.
- Raw provider ports should bind loopback or be otherwise protected.
- Cross-host launch requires an enrolled host identity and task authorization.
- Worktree paths must be constrained to approved roots.
- Prompt/context packs should avoid leaking secrets from env files, credentials,
  or unrelated repositories.
- MCP/tool availability should be governed by task policy.
- Approval mode should be explicit and recorded.

Governance policy dimensions:

- allowed providers;
- allowed hosts;
- allowed repos;
- allowed MCP servers/tools;
- allowed shell/network/file scopes;
- required checkpoints;
- budget limits;
- retention policy;
- reviewer requirements.

## Implementation plan

### Phase 0: Preserve and wrap current capabilities

- Freeze the existing OpenCode session, Jira, chat, pair-prompt, memory,
  artifact, workflow projection, OIDC, provisioning, and deployment behavior as
  compatibility surfaces.
- Add generic names and adapters around those surfaces without removing old
  routes.
- Confirm local deployment still works on local IP and Tailscale IP.
- Confirm Google OIDC still works through the single OIDC implementation with
  bundled Dex kept as the local issuer.

### Phase 1: Data model and UI inventory

- Introduce `AgentTask`, `WorkReference`, `Workbench`, `ProviderSession`, `Host`,
  `Worktree`, and `ContextPack` types.
- Keep compatibility adapters over current `CodeSession` and Jira stores.
- Add dashboard inventory views for tasks and live sessions.
- Show provider, host, owner, repo, branch, status, last activity, and links.
- Add rename/edit support at the task and workbench layers, preserving current
  session rename behavior.

### Phase 2: Jira migration into WorkReference

- Rename or wrap `JiraSessionLink` as `WorkReference`.
- Add generic APIs beside Jira-specific APIs.
- Keep Jira parser/enrichment as the first adapter.
- Emit `workReferences.updated`.
- Update context-pack builder to consume work references.
- Keep the existing Jira feature value: chat inference, manual attachment,
  item/team caches, source counts, evidence refs, search, and item detail pages.

### Phase 3: ReviewRequest and chat integration

- Generalize pair prompts into `ReviewRequest`.
- Attach task and workbench chat channels to review requests.
- Post system events for prompt approvals, memory reviews, work-reference
  changes, launches, stops, failures, handoffs, and provider links.
- Add dashboard review queue filters.

### Phase 4: Host registry

- Add host heartbeat and capability records.
- Register installed providers and versions per host.
- Track per-user provider auth readiness without reading credentials directly.
- Add host selection policy.
- Use runtime and Temporal worker heartbeats before adding a separate daemon.

### Phase 5: Worktree manager

- Create per-task worktrees.
- Track branch, HEAD, dirty files, conflicts, and cleanup state.
- Expose worktree status in the dashboard.

### Phase 6: Skill Library and brain import packaging

- Add `SkillPackage` and `SkillBundle` models.
- Wrap the existing skills package publishing/provisioning behavior behind the
  Skill Library model.
- Add inventory, review state, provider compatibility, dependency metadata,
  checksums, and install target tracking.
- Produce an importable OpenCortex-branded artifact from the old brain repository
  skills/scripts.
- Add launch readiness checks for required skill bundles on the selected
  host/Linux user.
- Record skill import, publish, install, validation, and use in the ledger.

### Phase 7: Context packs, memory, and skill bundles

- Build deterministic context packs from task objective, work references,
  selected repos, prior sessions, reviewed memory, artifacts, skill bundles, and
  policy.
- Store the immutable rendered launch prompt and attachment list.
- Add task/workbench/work-reference filters to memory search and capture.
- Reuse artifact ingest for transcripts and replay material.

### Phase 8: Activity ledger and projections

- Move session, chat, work-reference, review, memory, skill, workflow, provider,
  cost, commit, and PR activity into normalized ledger events.
- Keep existing rollups, but derive them from ledger events where practical.
- Add task/workbench/provider/host dashboard projections.

### Phase 9: Durable Temporal session orchestration

- Evolve `WorkbenchSessionWorkflow` into one long-running
  `AgentSessionWorkflow` per workbench.
- Add deterministic workflow ids and idempotent provider-process, prompt,
  stop, projection, ledger, and artifact activities.
- Add task-level parent workflows with child session and review workflows.
- Replace bounded probe completion with durable timers, heartbeats, commands,
  reconciliation, cancellation, and `continueAsNew`.
- Separate orchestration status from provider process and review status in
  projections and the dashboard.
- Remove authorization headers and other secrets from workflow inputs/history;
  pass opaque resource ids and resolve execution credentials inside activities.
- Add workflow replay tests, worker-restart tests, host-outage recovery tests,
  duplicate-launch prevention tests, and prompt deduplication tests.

### Phase 10: ACP AgentClient

- Define internal `AgentClient` around ACP concepts.
- Persist normalized ACP/provider events to the activity ledger.
- Implement Claude Code first, then Codex, then OpenCode as support allows.

### Phase 11: Claude Code Remote Control provider

- Launch Claude Code locally on selected hosts/users with `--remote-control`,
  `--session-id`, `--name`, selected cwd, and generated context pack.
- Capture `claude.ai/code` session URL when available.
- Store fallback URL.
- Monitor process health and provider events.

### Phase 12: Codex provider

- Add a Codex provider adapter using the selected Codex CLI/ACP path.
- Launch under the selected Linux user, cwd, worktree, and context pack.
- Capture provider session identifiers and native links where available.
- Feed Codex provider events into the normalized ledger.

### Phase 13: Review, PR, and ledger attribution

- Attach commits and PRs to tasks and provider sessions.
- Add review checkpoints.
- Add PR feedback ingestion.
- Add cost and model/tool attribution.

### Phase 14: Handoff and replay

- Add handoff workflow and roles.
- Add replay view from activity ledger and context packs.
- Add session summary generation and archival.

### Phase 15: Additional adapters and governance

- Add work-reference adapters after Jira: GitHub Issues/PRs, Linear, GitLab,
  Azure DevOps, Trello, documents, manual references, and prior OpenCortex
  sessions.
- Add model/provider policy routing.
- Add MCP/tool governance.
- Add tenant-scoped policies, quotas, and retention rules.

## Open decisions

- Whether the durable store for oversight should start as Postgres tables in the
  existing memory DB or use a dedicated ledger service.
- Whether the host agent should remain a Temporal worker long-term or split into
  a smaller always-online host daemon.
- Which provider failures may relaunch automatically and which require explicit
  operator approval.
- Which ACP implementation/library to adopt first.
- How much of provider-native approval UX should be mirrored in OpenCortex.
- Whether `Task` or `WorkItem` is the final product term.
- Whether OpenCortex should create PRs itself or delegate PR creation to the
  provider session under policy.

## Product position

Kepler is useful evidence that developers need a way to coordinate agent work
from task to merge. OpenCortex should not compete as another local desktop ADE.
It should be the web operations console for distributed, local-first agent work:
one place to see, launch, govern, hand off, replay, and attribute work across all
agents and all enrolled machines.
