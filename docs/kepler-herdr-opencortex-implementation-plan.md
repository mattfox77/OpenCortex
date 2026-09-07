# Kepler-Inspired Oversight, Classroom Mode, and Herdr Runtime Implementation Plan

Date: 2026-09-06
Target branch: `main`, implemented through short-lived branches or clean worktrees
Target implementer: GPT-5.5 medium intelligence

## Purpose

Implement the remaining multi-agent oversight design as a finite sequence of
vertical slices. OpenCortex will adopt the strongest Kepler workflow concepts,
integrate Herdr as its preferred host-local terminal runtime, and preserve the
OpenCortex capabilities that make the product useful across people, hosts,
providers, projects, and time.

The intended product boundary is:

```text
OpenCortex web and API control plane
  -> tenant / team / classroom scope
    -> Temporal task and agent-session workflows
    -> enrolled host executor
      -> HostSessionDriver
        -> Herdr workspace/tab/pane/PTY (preferred)
        -> direct process launch (compatibility fallback)
          -> Claude Code, Codex, OpenCode, or another agent
      -> AgentClient
        -> ACP (preferred structured control)
        -> provider-native adapter or hooks (fallback)
```

Kepler is a workflow and UX reference, not a code dependency. Herdr is an
Apache-2.0 component that OpenCortex can pin, wrap, and contract-test.

## Background

Kepler demonstrates a coherent developer workflow built around tasks,
resources, actions, isolated worktrees, concurrent agent sessions, an attention
queue, change review, and an Agent Graph. Its documented task model permits
multiple repositories, issues, pull requests, files, links, notes, and sessions
to contribute to one desired outcome:

- <https://help.gitkraken.com/kepler/tasks-and-resources/>
- <https://help.gitkraken.com/kepler/actions/>
- <https://help.gitkraken.com/kepler/agent-sessions/>
- <https://help.gitkraken.com/kepler/agent-graph/>
- <https://help.gitkraken.com/kepler/review-changes/>

Herdr supplies the lower-level runtime OpenCortex currently lacks: real
terminal ownership, workspaces/tabs/panes, detach and reattach, agent process
detection, native session references, raw terminal control, and a local
CLI/socket API:

- <https://herdr.dev/docs/>
- <https://herdr.dev/docs/agents/>
- <https://herdr.dev/docs/agent-automation/>
- <https://herdr.dev/docs/socket-api/>
- <https://herdr.dev/docs/session-state/>

OpenCortex already has the beginnings of a higher-level control plane: OIDC,
Linux-user provisioning, OpenCode and Codex launch planning, chat, Jira links,
prompt review, memory, artifacts, Temporal workflows, workflow projections,
skills, telemetry, and a local Podman deployment.

The same control-plane model should also support a classroom/cohort use case:
one teacher or mentor overseeing many student sessions, assignments, worktrees,
agent sessions, submissions, interventions, and replays. This is not a separate
product fork. It is a tenant-scoped operating mode that exercises the same
primitives as professional multi-agent oversight: roles, session sharing,
handoff/assist, policy, context packs, replay, ledger, cost attribution, and
review.

This plan supersedes the phase list in `docs/multi-agent-oversight.md` as the
canonical execution order. That document remains the comprehensive product and
architecture rationale.

## Verified Current Facts

- The repository is a Node 22/npm-oriented monorepo. Root `npm run check` and
  `npm run build` are the CI-equivalent quality gates.
- `packages/workbench` has OpenCode and Codex launch-plan implementations, but
  `SessionLauncher` still constructs OpenCode by default and directly owns
  child-process launch.
- `CodeSession` is persisted to `code-sessions.json`; IDs are currently derived
  from Linux usernames, preventing multiple independent workbenches per user.
- Runtime APIs and UI still use `/code/sessions`, Jira-specific links, and
  pair-prompt-specific terminology.
- `WorkbenchSessionWorkflow` is bounded by a probe count, stores an
  authorization header in workflow input, and records queued issue/prompt data
  without providing durable provider-process reconciliation.
- Workflow projections and task-ledger tables exist, but they are not the
  normalized, append-only business event ledger required for replay and
  attribution.
- `@opencortex/activity-ledger` currently computes optional in-memory rollups
  from a small event shape. It does not persist the event history.
- Durable memory, artifacts, review states, skill bundles, OIDC, Google issuer
  testing, Dex deployment, Linux-user provisioning, and runtime UI are already
  present and must be reused.
- `docs/workbench-providers.md` says OpenCode is the only implementation even
  though Codex launch planning now exists. Documentation status must be derived
  from implemented capability rather than retained as stale prose.
- No Herdr adapter, `HostSessionDriver`, ACP `AgentClient`, durable
  `AgentSessionWorkflow`, host registry, generic task/resource API, replay view,
  or Agent Graph is implemented yet.
- No classroom, cohort, assignment, enrollment, teacher oversight, student
  submission, or classroom-safe default policy model is implemented yet.

## Requirements

### Functional requirements

- Make `AgentTask` the unit of desired work. A task may contain many resources,
  worktrees, terminals, workbenches, provider sessions, reviews, artifacts, and
  memories.
- Support multiple workbenches per task and per user without sharing identity,
  port, process, or provider-session state accidentally.
- Support Claude Code, Codex, and OpenCode behind provider-neutral launch and
  interaction contracts.
- Provide configurable Actions such as Plan, Implement, Review, and Address
  Feedback, with task/resource applicability and provider/model overrides.
- Provide task, fleet, host, review, skills, ledger, and replay views plus a
  live Agent Graph and worktree change review.
- Provide a durable knowledge graph over reviewed memory, tasks, work
  references, artifacts, decisions, repositories, people, and skills. Keep it
  distinct from the Agent Graph, which represents execution activity.
- Support status requests, prompts, approvals, pause/resume, stop, relaunch,
  archive, and user handoff according to role and policy.
- Discover supported agent processes started outside OpenCortex, label them
  unscoped and externally started, and require an authorized claim/attach action
  before OpenCortex treats them as task work.
- Support classroom/cohort operation without a separate code path. A teacher can
  create classes, enroll students, publish assignments, launch or authorize
  per-student workspaces, observe progress, assist when policy permits, review
  submissions, and inspect replay/evidence. A student can see only their own
  assignments, sessions, shared teacher feedback, approved resources, and
  submission status unless additional sharing is granted.
- Support assignment templates that create one task per student or team from the
  same objective, resources, repository/worktree template, context-pack recipe,
  allowed skills, provider/model policy, budget, due date, submission rubric,
  and retention profile.
- Treat classroom session sharing as named modes rather than a generic shared
  link: observe, annotate, assist, pair, take over, hand off, review-only, and
  replay-only. Each mode must map to explicit roles, retained events, and policy
  checks.

### Runtime and resilience requirements

- Herdr is the preferred host-local runtime; direct process launch remains an
  explicit compatibility driver until Herdr deployment is proven.
- Run Herdr in the target Linux user's security context. Provider credentials
  remain in that user's home and are never copied into the control plane.
- Temporal owns durable lifecycle decisions, timers, commands, retries,
  reconciliation, and recovery. Herdr owns terminals and processes, not task
  truth.
- ACP is the preferred source for turns, tool calls, questions, permissions,
  and completion. Provider hooks rank second, Herdr inference third, and bare
  process liveness reports `unknown` rather than `idle`.
- Commands are idempotent and carry stable command IDs. A workflow replay,
  worker restart, or API retry must not duplicate a launch, prompt, approval,
  commit, or stop operation.
- Do not rely on Herdr's wait operation as proof of exactly one completed agent
  turn; correlate structured provider/ACP turn IDs where available.

### Authorization and scope requirements

- Every durable object and event carries `tenantId`; user-visible queries apply
  tenant and role scope before filters, pagination, or aggregation.
- Classroom objects carry `cohortId`, `assignmentId`, and `enrollmentId` where
  applicable, but tenant remains the outer authorization boundary. Cross-class
  visibility is denied by default even when users share the same tenant.
- Preserve owner, operator, reviewer, and observer roles. Provider-native URLs
  do not bypass OpenCortex authorization for control-plane actions or retained
  data.
- Add teacher, student, teaching-assistant, guardian/auditor, and class-admin
  role mappings as scoped role templates, not hard-coded bypasses. Classroom
  permissions still reduce to the same owner/operator/reviewer/observer control
  model at the task, workbench, ledger, replay, and artifact layers.
- Resolve OIDC subject to tenant membership, host authorization, and an
  explicit host/Linux-user mapping before launch.
- Do not expose the Herdr socket, raw provider ports, or unrestricted terminal
  input directly to the browser.
- Constrain repository, worktree, artifact, and terminal paths to configured
  roots after canonical path resolution.

### Data, retention, and migration requirements

- Add new tables and routes before removing old ones. Existing OpenCode
  sessions, names, threads, Jira evidence, chat, pair prompts, memory,
  artifacts, and workflow projections remain readable throughout migration.
- Classroom records are additive. Existing professional/team tasks must not be
  forced into a class or cohort, and existing users must continue to work in a
  non-classroom tenant mode.
- Import `code-sessions.json` idempotently into durable workbench records and
  retain the file as rollback evidence until a later, explicit cleanup release.
- Store immutable context-pack versions and append-only normalized activity
  events. Redaction may replace protected payload fields but must retain event
  identity, actor, type, time, correlation IDs, and redaction reason.
- Define tenant-configurable retention for terminal scrollback, transcripts,
  artifacts, context packs, provider payloads, and cost records. Terminal
  history is disabled by default until a retention policy enables it.
- The legacy Brain/BrainTrust content conversion remains governed by its
  dedicated migration plan. This plan implements the Skill Library, import
  contract, validation, installation, and consumption of the resulting
  OpenCortex-branded artifact.

### Payload and performance requirements

- Inventory APIs use cursor pagination and server-side filtering; do not return
  full transcripts, diffs, or event payloads in fleet rows.
- Store large transcripts, terminal captures, patches, and attachments in the
  artifact store. Ledger events reference those artifacts instead of embedding
  unbounded blobs.
- Bound context-pack render size by policy and record omissions. A launch must
  show what was included, excluded, summarized, or truncated.
- Classroom fleet and roster APIs must not load terminal scrollback,
  transcripts, complete diffs, or full replay payloads in roster rows. Teacher
  dashboards use summary/projection rows and lazy-load evidence only after an
  authorized drill-in.
- Stream graph and session updates incrementally. Initial fleet and task views
  must remain usable when detailed provider telemetry is unavailable.

### Operational requirements

- The reference deployment remains Podman Quadlet/systemd and is reachable on
  configured local and Tailscale addresses through the authenticated runtime.
- Raw Herdr and provider interfaces remain host-local unless an explicitly
  authenticated host channel is introduced.
- Pin a tested Herdr version; surface its version and socket compatibility in
  host readiness.
- Preserve the single OIDC implementation: Dex bundled, tested against Google
  as the second compliant issuer.
- Provide classroom-safe default policies: conservative shell/network/file
  access, explicit approval for destructive repo operations, student-visible
  retention notice, teacher audit access, per-assignment budget caps, and no
  provider credential sharing between teacher and student accounts.
- Every slice must pass its scoped tests, self-audit, `git diff --check`, and
  the applicable broader repository gates before commit and push.

### Non-negotiable ownership boundaries

| Concern | Authority |
|---|---|
| Task intent, roles, policy, durable history | OpenCortex |
| Lifecycle decisions and recovery | Temporal workflow |
| PTY, shell, process, pane, local attach | `HostSessionDriver` / Herdr |
| Structured agent interaction | `AgentClient` / ACP |
| Provider authentication | Provider CLI under target Linux user |
| Durable business event history | OpenCortex activity ledger |
| Large immutable evidence | OpenCortex artifact store |
| Reviewed reusable knowledge | OpenCortex memory |
| Installable capabilities | OpenCortex Skill Library |
| Classroom roster, assignment, and oversight policy | OpenCortex tenant domain |

## Findings / Gaps To Resolve

1. The current domain object conflates an OpenCortex workbench with provider
   conversation sessions and OpenCode threads.
2. Session persistence is host-local JSON rather than tenant-scoped durable
   control-plane data.
3. Runtime starts detached processes itself and has no terminal/session driver
   abstraction, attach primitive, or cross-host process identity.
4. Temporal records control intent but does not own the complete workbench
   lifecycle, and secrets currently enter workflow history.
5. Provider control is OpenCode-specific. ACP permissions, questions, turns,
   tool calls, diffs, and subagents have no common internal event model.
6. Jira, pair prompts, and code sessions expose useful behavior through
   provider-specific names and routes.
7. Task context is assembled informally rather than rendered and retained as a
   deterministic, immutable context pack.
8. Skills can be packaged and provisioned, but are not inventoried, selected,
   installed, and attributed through task launch policy.
9. The ledger cannot support replay, file collision detection, cost
   attribution, or a historical Agent Graph.
10. Multi-tenancy, handoff, replay, cost policy, model routing, and MCP/tool
    governance are documented but not implemented end to end.
11. The existing runtime UI is session-centric and lacks the task/resource,
    attention, host, review, graph, and change-review workflows.
12. The classroom use case has no durable class/cohort, enrollment, assignment,
    teacher oversight, student submission, or education-safe policy model.

## Implementation Slices

### Slice 1: Tenant-Scoped Domain and Compatibility Foundation

Purpose:

Create durable, provider-neutral control-plane records without breaking the
working OpenCode, Jira, chat, pair-prompt, and session APIs.

Files expected to change:

- `packages/memory/migrations/020_control_plane_domain.sql` and migration tests
- `packages/runtime/src/domain/*` for domain types and authorization helpers
- `packages/runtime/src/tasks/*`, `packages/runtime/src/code/sessionStore.ts`
- `packages/runtime/src/http/routes.ts`
- `packages/runtime/test/controlPlaneStore.test.ts`
- `packages/runtime/test/http.test.ts`
- `packages/runtime/test/sessionStore.test.ts`

Implementation:

- Add `tenants`, `tenant_memberships`, `agent_tasks`, `work_references`,
  `workbenches`, `provider_sessions`, `hosts`, `host_user_capabilities`,
  `worktrees`, `context_packs`, `review_requests`, `cohorts`,
  `cohort_enrollments`, `assignment_templates`, `assignment_instances`,
  `session_share_grants`, and `submissions` with foreign keys, timestamps,
  stable public IDs, lifecycle constraints, and tenant indexes.
- Backfill existing identities into one explicit local tenant. Do not infer
  cross-tenant membership from email domain.
- Add owner/operator/reviewer/observer role checks and tenant-scoped query
  helpers. Add RLS and service-role policies consistent with current memory DB
  access conventions.
- Add role-template mapping for class admin, teacher, teaching assistant,
  student, and auditor. Implement it as data-driven grants over tenant,
  cohort, assignment, task, workbench, artifact, ledger, and replay scopes.
- Make workbench IDs random and immutable. Preserve provider-native session IDs
  only in `provider_sessions`.
- Implement an idempotent startup importer from `code-sessions.json`. Map
  OpenCode sessions, threads, names, owner, Linux user, workspace, port, URL,
  command, and provider version. Record the legacy ID as migration metadata.
- Add `/tasks`, `/tasks/:id`, `/tasks/:id/resources`, `/workbenches`, and
  `/workbenches/:id` APIs with cursor pagination, filters, and role checks.
- Add additive, low-level `/cohorts`, `/cohorts/:id/enrollments`,
  `/assignments/templates`, `/assignments/:id/instances`, and
  `/session-share-grants` APIs with tenant and cohort scope. These APIs may
  expose only domain records in this slice; full classroom workflows arrive in
  Slice 8.
- Keep existing `/code/sessions` behavior through compatibility adapters and
  include canonical task/workbench IDs in legacy responses. Do not delete or
  rewrite the source JSON file.
- Add a minimal task/workbench inventory to the current UI using the new API,
  while keeping the current session launch/open workflow available.

Tests:

- Empty-database and upgrade migration tests, including constraint and index
  checks.
- Tenant isolation for list, get, create, rename, archive, and membership.
- Idempotent JSON import, corrupt/partial legacy records, and repeated startup.
- Multiple workbenches for one user and multiple provider sessions per
  workbench.
- Compatibility route parity for existing session list, rename, open, restore,
  and archive behavior.
- Cursor pagination does not leak rows across tenant boundaries.
- Cohort enrollment and session-share-grant RLS, including teacher can list
  enrolled student task summaries, student cannot list peer sessions by default,
  and auditor gets read-only evidence scope.

Validation:

```bash
npm --prefix packages/memory run check
npm --prefix packages/memory run check:empty-db
npm --prefix packages/runtime run check
npm run build
git diff --check
```

Acceptance:

- Existing local sessions remain readable and usable.
- Two workbenches can be created for one user without ID, port, or provider
  state collision.
- New records and APIs are tenant-scoped and reject unauthorized role actions.
- Re-running migration/import creates no duplicate task, workbench, or provider
  session.
- Classroom domain records can be created, listed, archived, and queried without
  forcing existing non-classroom tasks into a cohort.

Self-audit tenant scope, compatibility behavior, and migration reversibility.
Resolve findings in this slice before committing. Commit and push after the
slice passes validation.

### Slice 2: Host Registry, Worktrees, and Herdr HostSessionDriver

Purpose:

Move terminal and provider-process ownership behind a host-local abstraction,
using Herdr where available while retaining an explicit direct-process fallback.

Files expected to change:

- `packages/host-runtime/package.json`, `tsconfig.json`, and `src/*` (new package)
- `packages/workbench/src/index.ts` and provider-specific modules
- `packages/runtime/src/hosts/*`
- `packages/runtime/src/code/sessionLauncher.ts`
- `packages/runtime/src/system/provisioning.ts`
- `packages/orchestrator/src/worker.ts`
- `deploy/podman-quadlet/*` and deployment readiness scripts
- host-runtime, runtime launcher, provisioning, and readiness tests

Implementation:

- Define `HostSessionDriver` operations for capability probe, create/open
  workspace, create pane, start command, send input, read bounded output,
  subscribe/snapshot state, stop, archive, and recover native session metadata.
- Implement `DirectProcessHostSessionDriver` by wrapping current spawn/port/log
  behavior. It is a compatibility driver, not an implicit fallback after a
  failed Herdr launch.
- Implement `HerdrHostSessionDriver` against a pinned CLI/socket contract.
  Capture Herdr workspace/tab/pane/terminal IDs and provider-native session
  references. Reject unknown response fields only when they violate required
  semantics; retain raw versioned payloads for diagnostics.
- Run one Herdr server context per execution user or an equivalently isolated
  configuration proven not to cross user homes, sockets, process ownership, or
  credentials. Invoke it under the mapped Linux user.
- Never expose the Herdr socket to the browser. Runtime and host workers issue
  authorized commands and return normalized state or bounded, redacted output.
- Add host registration and heartbeats with driver/provider versions,
  capabilities, labels, capacity, path roots, and per-user provider readiness.
- Add a worktree manager with canonical path validation, branch/base selection,
  setup commands, dirty/conflict/ahead/behind state, provenance, and conservative
  cleanup rules. Default to isolated worktrees for repository-backed tasks.
- Add host selection: explicit host, required labels, authorized Linux-user
  mapping, provider readiness, repository locality, capacity, and health.
- Add host and worktree panels to the UI with stale/unknown state distinguished
  from offline/failed state.

Tests:

- Contract fixtures for supported Herdr snapshot, event, error, and version
  payloads.
- Driver parity tests for start, input, bounded output, stop, archive, and
  reconciliation.
- Commands execute as the intended Linux user and never inherit another user's
  credential paths.
- Socket/path traversal, symlink escape, oversized output, stale heartbeat,
  unsupported Herdr version, and unavailable-driver behavior.
- Worktree creation from the remote default branch, existing branch handling,
  setup-command failure, dirty cleanup refusal, and PR-linked isolation.
- Host selection is deterministic for equivalent inputs and reports why a host
  was rejected.

Validation:

```bash
npm --prefix packages/host-runtime run check
npm --prefix packages/workbench run check
npm --prefix packages/runtime run check
npm --prefix packages/orchestrator run check
npm run deploy:check
npm run build
git diff --check
```

Acceptance:

- The same launch request works through direct-process and Herdr drivers with a
  common normalized result.
- A Herdr-managed terminal can be detached, rediscovered, and reconciled after
  runtime restart without creating a duplicate process.
- Host readiness displays the exact driver and provider capability used for a
  launch decision.
- No browser endpoint can access an unscoped Herdr socket or arbitrary host
  filesystem path.

Self-audit user isolation, socket exposure, path handling, and fallback
semantics. Resolve findings in this slice before committing. Commit and push
after the slice passes validation.

### Slice 3: Durable Temporal Task and Agent-Session Authority

Purpose:

Make Temporal the sole durable authority for task and workbench lifecycle while
Herdr remains the terminal/process substrate.

Files expected to change:

- `packages/orchestrator/src/workflows/agentTask.ts`
- `packages/orchestrator/src/workflows/agentSession.ts`
- `packages/orchestrator/src/workflows/reviewRequest.ts`
- `packages/orchestrator/src/activities/*`
- `packages/orchestrator/src/worker.ts` and command scripts
- `packages/runtime/src/workflows/*` and launch routes
- `scripts/check-workflow-authority.mjs`
- Temporal unit, replay, restart, and integration tests

Implementation:

- Align Temporal SDK package versions before adding workflow tests; do not leave
  runtime/client/testing packages on incompatible minor lines.
- Introduce one deterministic `AgentTaskWorkflow` per task and one
  `AgentSessionWorkflow` per workbench. Preserve existing workflow IDs as
  correlation metadata during migration.
- Replace bounded probing with durable timers, workflow queries, Updates for
  accepted/rejected commands, signals for asynchronous events, heartbeats for
  long host activities, cancellation scopes, and `continueAsNew` thresholds.
- Model preflight, provisioning, worktree preparation, context readiness,
  launch, supervision, waiting, recovery, stopping, archival, and terminal
  states separately.
- Pass only opaque IDs and non-secret policy into workflows. Activities resolve
  short-lived credentials and internal authorization at execution time. Remove
  `authorizationHeader` from workflow input and retained projection data.
- Assign stable command IDs for launch, prompt, approval, pause, resume, stop,
  and archive. Persist activity effects before acknowledging workflow commands.
- Reconcile workflow intent with host and Herdr snapshots after worker/runtime
  restart. Never auto-relaunch when an existing process cannot be disproven.
- Distinguish orchestration state, process state, agent state, and review state
  in projections and API responses.
- Keep compatibility signals (`stopSession`, `archiveSession`, `attachIssue`,
  `sendPairPrompt`) as adapters to canonical commands for one release.
- Show durable workflow status and the most recent recovery decision in task and
  workbench detail UI.

Tests:

- Determinism/replay tests for every workflow change.
- Worker restart during launch, prompt, wait, stop, and archive.
- Host outage and recovery, duplicate launch prevention, duplicate command
  delivery, delayed event delivery, cancellation, and `continueAsNew` state
  carry-forward.
- Secret-scanning assertion over workflow inputs, memo, search attributes,
  projection data, results, and errors.
- Reconciliation outcomes for matching process, stale record, conflicting
  process identity, unavailable host, and ambiguous liveness.

Validation:

```bash
npm --prefix packages/orchestrator run check
npm --prefix packages/orchestrator run test:replay
npm --prefix packages/runtime run check
npm run workflow:authority
npm run build
git diff --check
```

Acceptance:

- A workbench remains durably controllable across runtime and worker restart.
- Replayed histories remain deterministic and do not duplicate side effects.
- No provider or OpenCortex bearer credential appears in Temporal history.
- Runtime cannot mutate a managed provider process outside its owning workflow.

Self-audit determinism, idempotency, history payloads, and ambiguous recovery.
Resolve findings in this slice before committing. Commit and push after the
slice passes validation.

### Slice 4: ACP AgentClient and Provider Session Management

Purpose:

Provide one structured interaction model for Claude Code, Codex, OpenCode, and
future agents while preserving provider-native strengths.

Files expected to change:

- `packages/agent-client/package.json`, `tsconfig.json`, and `src/*` (new package)
- provider adapters under `packages/workbench/src/providers/*`
- `packages/runtime/src/providers/*`
- `packages/orchestrator/src/activities/provider*`
- provider configuration, provisioning, API, UI, and test files

Implementation:

- Define `AgentClient` around initialize/resume, capabilities, send prompt,
  stream events, answer question, decide permission, request status, interrupt,
  compact, and terminate. Preserve raw provider event references without
  leaking unbounded payloads into list APIs.
- Define normalized events for session, turn, text, thought summary, tool call,
  subagent, file touch, question, permission, diff, usage, cost, completion,
  interruption, disconnection, and error.
- Implement an ACP adapter after a time-boxed library/protocol evaluation.
  Contract-test initialize, capability negotiation, prompt, cancellation,
  permission, malformed messages, disconnect, resume, and version skew.
- Implement provider integrations in this order: Claude Code, Codex, OpenCode.
  Use ACP where supported and explicit provider-native adapters otherwise.
- Claude launch must start in the selected worktree with the rendered initial
  prompt and Remote Control active. Capture the session-specific
  `claude.ai/code` URL when the CLI exposes it; otherwise store the documented
  fallback URL and state that a specific deep link is unavailable.
- Codex launch must run under the selected user, directory, account, model,
  permission mode, and effort where supported. Do not treat codexapp as the
  durable session authority.
- Keep the existing OpenCode web proxy and prompt path behind the common
  contracts until an ACP-capable OpenCode path is proven.
- Support multiple provider accounts per Linux user as named, isolated
  credential contexts. Do not copy credentials or use undocumented provider
  token APIs for mandatory functionality.
- Apply state precedence: ACP, authoritative provider hooks, Herdr inference,
  then process liveness. Include `source`, `observedAt`, and `confidence` in
  normalized state.
- Render provider/model/mode/effort/account controls and provider-native links
  from capabilities rather than hard-coded UI options.

Tests:

- Protocol contract and malformed/disconnected stream tests.
- Prompt and approval command deduplication across reconnect and workflow
  replay.
- Provider capability differences, account isolation, missing binary, failed
  auth, unavailable model, native-link capture, and fallback-link behavior.
- State precedence and transition tests, including inferred blocked/idle state
  being replaced by authoritative ACP events.
- Regression tests for existing OpenCode proxy, thread selection, and prompt
  delivery.

Validation:

```bash
npm --prefix packages/agent-client run check
npm --prefix packages/workbench run check
npm --prefix packages/runtime run check
npm --prefix packages/orchestrator run check
npm run build
git diff --check
```

Acceptance:

- The UI can start and continue Claude, Codex, and OpenCode workbenches through
  one capability-driven API.
- A provider session records its native ID, resume metadata, account context,
  structured state source, and best available native link.
- Permissions and questions appear as OpenCortex review items and answers reach
  exactly the intended provider turn.
- Provider credentials remain provider-owned and user-isolated.

Self-audit protocol assumptions, credential boundaries, state confidence, and
provider fallback behavior. Resolve findings in this slice before committing.
Commit and push after the slice passes validation.

### Slice 5: Generic Resources, Actions, Context Packs, and Skill Library

Purpose:

Turn issues, PRs, notes, repositories, memory, artifacts, and skills into an
auditable task-launch context rather than provider-specific side features.

Files expected to change:

- `packages/runtime/src/workTracking/*` and compatibility Jira adapter
- `packages/runtime/src/context/*`
- `packages/runtime/src/actions/*`
- `packages/runtime/src/skills/*`
- `packages/skills/src/*` and bundle/import documentation
- memory migration, CLI, route, UI, and test files

Implementation:

- Implement generic `WorkReference` storage and APIs with typed provider
  adapters. Migrate current Jira parsing, cache, evidence, source counts,
  inference, search, and detail behavior behind the generic contract.
- Add GitHub issue/PR and manual/link/note resources next. Leave Linear,
  GitLab, Azure DevOps, Trello, and documents behind the same adapter contract
  unless credentials are already available during this slice.
- Dual-write legacy Jira mutations to canonical work references and emit
  `workReferences.updated`. Retain legacy routes as adapters for one release.
- Implement configurable Actions with title, prompt/template, applicable
  resource kinds, required checkpoints, provider/account/model/mode/effort
  override, and tenant/project/user scope. Ship Plan, Implement, Review, and
  Address Feedback defaults.
- Build deterministic, immutable context packs from objective, resources,
  repositories, prior sessions, reviewed memory, selected artifacts, skill
  bundles, and policy. Canonicalize source order and record source versions,
  hashes, omissions, summaries, and truncation.
- Add injection and secret controls: trust labels, delimiting untrusted external
  content, approved path roots, explicit secret-pattern exclusions, and a final
  preview before policy-sensitive launches.
- Add Skill Library models/APIs for packages, versions, bundles, compatibility,
  dependencies, review state, signatures/checksums, scope, installation targets,
  and validation results.
- Consume the separately produced Brain migration artifact through the same
  importer; do not add Brain/BrainTrust-specific runtime paths or branding.
- Install and validate required skill bundles on the selected host/user before
  provider launch. Record exact package versions in the context pack and
  provider session.
- Add task resource, Action, context preview, and Skill Library views to the UI.

Tests:

- Jira compatibility parity and dual-write idempotency.
- Work-reference adapter contract, provider failure, stale cache, malformed URL,
  evidence retention, and tenant isolation.
- Action inheritance/override and applicability resolution.
- Context-pack byte stability for equivalent inputs, size ceilings, omission
  manifests, untrusted content boundaries, secret exclusion, and authorization.
- Skill signature/checksum failure, dependency failure, provider
  incompatibility, install idempotency, cross-user isolation, and launch block
  when required validation fails.
- Import of a representative neutral OpenCortex skill artifact.

Validation:

```bash
npm --prefix packages/memory run check
npm --prefix packages/skills run check
npm --prefix packages/cli run check
npm --prefix packages/runtime run check
npm run build
git diff --check
```

Acceptance:

- Jira behavior survives through generic task/resource APIs and UI.
- The same Action can run against a manual task, Jira issue, or GitHub PR
  without provider-specific orchestration code.
- Every launch references an immutable context pack and exact skill bundle
  versions.
- Oversized, untrusted, unauthorized, or secret-bearing context is visibly
  omitted or blocks launch according to policy.

Self-audit compatibility, deterministic rendering, content trust, and skill
supply-chain integrity. Resolve findings in this slice before committing.
Commit and push after the slice passes validation.

### Slice 6: Activity Ledger, Cost, Replay, Handoff, and Governance

Purpose:

Create the durable audit spine required for historical reconstruction,
attribution, collaboration, policy enforcement, and accountable automation.

Files expected to change:

- `packages/memory/migrations/021_activity_events.sql`
- `packages/activity-ledger/src/*` and tests
- `packages/runtime/src/ledger/*`, `replay/*`, `policy/*`, and `handoff/*`
- `packages/runtime/src/knowledge/*`
- `packages/orchestrator/src/activities/ledger*` and workflow policy hooks
- `packages/cli/src/*`
- ledger, replay, handoff, policy, and RLS tests

Implementation:

- Add an append-only `activity_events` schema with tenant, actor, task,
  workbench, provider session, workflow, command, turn, tool, artifact, worktree,
  commit, and PR correlation IDs; event version; source/confidence; occurred and
  observed times; bounded metadata; and optional artifact payload reference.
- Add transactional event append plus an outbox where state mutation and event
  publication cannot be atomic directly. Consumers must be idempotent by event
  ID and projection version.
- Normalize task/resource/context/skill/workflow/provider/review/terminal/file/
  commit/PR/memory/handoff/policy/cost/classroom lifecycle events.
- Derive task, fleet, host, attention, graph, usage, and cost projections from
  ledger events. Do not make provider logs or Temporal history the business
  system of record.
- Record provider-reported usage and cost as authoritative only when documented
  as such. Label estimates with model, price source/version, currency, and
  estimation method. Never use undocumented private provider endpoints as a
  required source.
- Implement chronological replay from context packs, normalized events,
  provider transcript artifacts, diffs, commits, PRs, chat, and review
  decisions. Represent missing telemetry explicitly.
- Implement a tenant-scoped knowledge graph whose nodes reference canonical
  OpenCortex records rather than duplicate their full content. Add typed,
  directed edges with provenance, confidence, review state, valid time, and
  source event/artifact IDs. Build graph mutations from reviewed memory and
  explicit user/agent proposals; inferred edges remain pending until policy or
  a reviewer accepts them.
- Provide bounded neighborhood traversal, path lookup, and hybrid text/vector
  plus graph retrieval for context packs. Enforce tenant and role scope before
  traversal so an allowed starting node cannot reveal a forbidden neighbor.
- Implement user handoff with target-user acceptance, role transfer, provider
  access/readiness checks, a generated handoff packet, pending-action transfer,
  and immutable before/after audit events. Do not claim provider-native
  conversation ownership changed unless the provider confirms it.
- Implement tenant/project/task policies for providers, models, hosts, repos,
  MCP servers/tools, shell/network/file scopes, approvals, reviewers, budgets,
  retention, and relaunch behavior. Evaluate policy at launch and before every
  governed command.
- Implement classroom policy overlays for cohort, assignment, enrollment, and
  share mode. Defaults should require teacher approval for destructive shell,
  network expansion, external publication, provider-account changes, and
  cross-student sharing. Policies must state which evidence the teacher can
  retain and which transcript/terminal data is disabled, summarized, or
  exportable.
- Emit assignment, enrollment, share, observe, assist, annotate, takeover,
  submission, grading/review, and rubric-result events. These events must be
  sufficient to reconstruct who saw or controlled a student's session and when.
- Add CLI commands for task/workbench/host inventory, ledger tail, replay
  export, handoff, and skill status.
- Add ledger/replay/handoff/policy UI with source, confidence, actor, time,
  decision rationale, and retained evidence. Add a separate knowledge graph
  view for durable concepts and relationships; do not mix it with the live
  task/turn/tool/file Agent Graph.

Tests:

- Append-only and tenant RLS enforcement; forbidden update/delete paths.
- Outbox crash/retry, duplicate event consumption, ordering ties, late events,
  projection rebuild, schema-version compatibility, and redacted payloads.
- Cost aggregation with mixed currencies, absent usage, estimates, corrections,
  and provider-reported values.
- Replay fidelity with full, partial, inferred, redacted, and missing telemetry.
- Knowledge-node/edge provenance, duplicate proposal merge, review workflow,
  temporal validity, bounded traversal, deletion/redaction propagation, and
  tenant isolation at every hop.
- Handoff authorization, acceptance/rejection, unavailable target credentials,
  pending approvals, active turn, rollback before acceptance, and provider
  ownership caveat.
- Policy precedence, explicit deny, tool/MCP approval, budget boundary, retention
  application, and audit completeness.
- Classroom policy precedence, teacher/assistant/student/auditor share modes,
  submission audit events, per-assignment budget boundaries, and evidence export
  retention.

Validation:

```bash
npm --prefix packages/memory run check
npm --prefix packages/memory run check:empty-db
npm --prefix packages/activity-ledger run check
npm --prefix packages/cli run check
npm --prefix packages/runtime run check
npm --prefix packages/orchestrator run check
npm run build
git diff --check
```

Acceptance:

- Projections can be deleted and rebuilt from retained ledger events with
  equivalent user-visible state.
- A replay clearly distinguishes observed, inferred, estimated, missing, and
  redacted information.
- A handoff changes OpenCortex responsibility only after authorized acceptance
  and never silently shares provider credentials.
- Every governed action produces a policy decision event with the evaluated
  policy version.
- Approved knowledge relationships can be retrieved into a context pack with
  complete provenance, while pending or unauthorized relationships are absent.
- Classroom oversight events can be reconstructed from the ledger without using
  provider logs as the system of record.

Self-audit event completeness, immutable-history enforcement, cost labeling,
handoff semantics, classroom visibility, and policy bypasses. Resolve findings
in this slice before committing. Commit and push after the slice passes
validation.

### Slice 7: Multi-Agent Oversight, Attention Queue, Agent Graph, and Git Review

Purpose:

Deliver the Kepler-inspired oversight experience as a web-first, cross-host,
multi-user OpenCortex console backed by durable OpenCortex state.

Files expected to change:

- `packages/runtime/src/ui/public/index.html`
- `packages/runtime/src/ui/public/app.js`
- `packages/runtime/src/ui/public/styles.css`
- new runtime query/projection routes and tests
- `docs/multi-agent-oversight-wireframes.html` where final behavior differs

Implementation:

- Build top-level Tasks, Agents, Hosts, Review, Ledger, Memory, and Skills views
  using a consistent application shell, URL-addressable state, preserved
  filters, cursor pagination, loading/partial/stale/error/empty states, and
  keyboard-accessible actions.
- Make the default fleet surface an attention queue sorted by blocked
  questions/permissions, failures, policy/budget exceptions, conflicts, unread
  completion, stale state, then healthy work.
- Provide rows and grouped columns for task/fleet work. Show provider, account,
  host, owner, task, references, repo/worktree/branch, separate orchestration/
  process/agent/review states, last observation age, confidence, pending action,
  cost basis, and provider link.
- Build task detail around resources, workbenches, terminals, worktrees,
  context, reviews, chat, memory, artifacts, and activity. Permit side-by-side
  inspection of several sessions without requiring raw terminal embedding.
- Show Herdr-discovered external sessions in an Unscoped section with host,
  Linux user, provider, cwd, state source, and observed time. Claiming one must
  attach it to an authorized task/workbench without pretending OpenCortex
  launched or owns prior activity.
- Build the live and replayable Agent Graph from the same projection snapshot:
  `Task -> Workbench -> Turn -> Tool/Subagent -> File`. Group repeated calls,
  expose hidden/missing counts, freeze/resume live layout, filter depth, and
  warn when concurrent sessions touch the same file or worktree.
- Build worktree change review with changed/staged/unstaged files, bounded diffs,
  image previews where supported, commit history, branch divergence, test
  status, safe stage/unstage, named destructive confirmation, commit, push, and
  PR association. Govern write actions through task policy and workflow command
  IDs.
- Add provider transcript/event view where structured telemetry exists and a
  terminal attach/open action where policy permits. Do not imply an inferred
  terminal state is a complete transcript.
- Meet WCAG 2.2 AA basics already specified in the oversight design: semantic
  controls, persistent labels, text state equivalents, logical keyboard order,
  visible focus, non-hover access, live-region announcements, and no
  color-only meaning.
- Keep payloads bounded: graph summary first, lazy node detail, virtualized or
  paginated long lists, artifact-backed large diffs/transcripts.

Tests:

- Runtime API tests for filters, pagination, authorization, stale state,
  projection version, and bounded payloads.
- Browser tests for attention ordering, preserved filters, task navigation,
  side-by-side sessions, permission decision, handoff, graph filtering/freeze,
  collision warning, diff review, and error recovery without lost input.
- Keyboard-only and automated accessibility tests for primary workflows.
- Responsive screenshots at mobile, desktop, and wide desktop; verify no
  overlapping controls, clipped identifiers, blank graph, or inaccessible
  actions.
- Large fixtures: many tasks/sessions/events/files plus partial provider
  telemetry and disconnected hosts.

Validation:

```bash
npm --prefix packages/runtime run lint
npm --prefix packages/runtime run format:check
npm --prefix packages/runtime run check
npm run build
git diff --check
```

Acceptance:

- An operator can find the highest-priority human intervention, inspect its
  evidence, act, and verify the resulting state without opening Temporal UI or
  logging into the host.
- The same task can show agents on multiple hosts and providers without losing
  tenant, user, worktree, or state-source distinctions.
- Live Agent Graph and chronological replay agree because both derive from the
  same retained events and projection version.
- Core workflows are keyboard operable and remain usable under partial or stale
  telemetry.

Self-audit information hierarchy, action safety, accessibility, payload bounds,
and misleading state presentation. Resolve findings in this slice before
committing. Commit and push after the slice passes validation.

### Slice 8: Classroom and Cohort Oversight Mode

Purpose:

Implement the teacher/student classroom use case as a first-class operating
mode of the same tenant, task, workbench, policy, ledger, replay, and oversight
architecture.

Files expected to change:

- `packages/runtime/src/classroom/*`
- classroom routes, policy helpers, projection queries, and tests
- `packages/runtime/src/ui/public/index.html`
- `packages/runtime/src/ui/public/app.js`
- `packages/runtime/src/ui/public/styles.css`
- `packages/orchestrator/src/workflows/assignment*.ts`
- `packages/orchestrator/src/activities/classroom*`
- `packages/cli/src/*`
- `docs/multi-agent-oversight.md`
- `docs/multi-agent-oversight-wireframes.md`
- `docs/multi-agent-oversight-wireframes.html`

Implementation:

- Add a classroom mode switch that is available only to users with scoped
  classroom roles. It must reuse the same authenticated runtime shell and must
  not create a parallel auth, session, provider, or host system.
- Implement cohort/class management: create, rename, archive, enroll, remove,
  invite/link existing users, assign teacher/assistant/student/auditor roles,
  and list roster status with cursor pagination.
- Implement assignment templates with objective, instructions, resources,
  repositories, branch/worktree template, context-pack recipe, allowed skills,
  action defaults, provider/model policy, MCP/tool policy, budget, due date,
  submission requirements, rubric, and retention profile.
- Implement assignment publishing. Publishing creates one
  `assignment_instance` and one `AgentTask` per student or team, with
  deterministic idempotency keys so retries do not duplicate tasks or
  worktrees.
- Implement student session launch from an assignment. The launch must apply
  the assignment policy, select the authorized host/user mapping, render the
  assignment context pack, install required skills, and create the workbench
  through the same Temporal/HostSessionDriver/AgentClient path as professional
  tasks.
- Implement teacher oversight roster: class, assignment, student, task state,
  workbench state, provider, host, last activity, pending question/permission,
  submission state, budget/cost, and policy exception. Rows must be projection
  summaries; terminal output, transcripts, diffs, and replay load only after
  authorized drill-in.
- Implement share modes:
  - `observe`: teacher can view allowed summary/detail evidence without
    controlling the session.
  - `annotate`: teacher can add comments or feedback events without provider
    control.
  - `assist`: teacher can send an explicit helper prompt or approved command
    according to policy while preserving the student's ownership.
  - `pair`: teacher and student can both contribute through governed commands.
  - `takeover`: teacher temporarily becomes operator after explicit evented
    reason and policy approval.
  - `handoff`: responsibility transfers to another accepted user using the
    Slice 6 handoff workflow.
  - `review-only`: reviewer can inspect submission artifacts and comments but
    cannot inspect unretained terminal/transcript data.
  - `replay-only`: viewer can inspect retained replay evidence without live
    control.
- Implement a student dashboard with current assignments, due dates, launch or
  resume action, teacher feedback, required submissions, provider link when
  available, budget/limit state, and submission history.
- Implement submissions: mark ready for review, attach artifacts/commits/PRs,
  capture final context/replay reference, support return-for-revision, accepted,
  rejected, and scored/reviewed states. Rubric scoring must be evented and
  exportable without requiring provider logs.
- Implement classroom exports for roster progress, assignment submissions,
  review/rubric results, cost summaries, and retained replay/evidence manifests.
  Exports must apply tenant/cohort/role scope and retention policy.
- Implement classroom-safe policy presets and UI copy: conservative shell and
  network defaults, destructive repo operation approvals, no hidden credential
  sharing, clear retained-evidence status, per-assignment budget caps, and
  student-visible session-sharing state.
- Update wireframes and the oversight design doc to show the classroom mode as
  a role-scoped variant of the same oversight console.

Tests:

- Cohort and enrollment CRUD with tenant isolation, role checks, archived
  classes, removed students, and duplicate invites.
- Assignment template validation, publish idempotency, per-student task
  creation, worktree branch naming, policy inheritance, and partial publish
  retry after failure.
- Student launch/resume flow through Temporal, HostSessionDriver, AgentClient,
  context pack, and skill validation using test doubles where external
  providers are unavailable.
- Teacher roster projection with many students, stale hosts, blocked prompts,
  partial telemetry, missing provider links, and bounded payloads.
- Share mode authorization and ledger events for observe, annotate, assist,
  pair, takeover, handoff, review-only, and replay-only.
- Submission lifecycle, rubric result events, return-for-revision, late
  submission, artifact attachment authorization, and export retention.
- Browser tests for teacher dashboard, student dashboard, drill-in, share-mode
  banner, submission review, keyboard-only navigation, and responsive layouts.
- Privacy tests proving a student cannot see a peer session, a teacher cannot
  access another cohort without membership, and an auditor cannot control a
  live session.

Validation:

```bash
npm --prefix packages/runtime run lint
npm --prefix packages/runtime run format:check
npm --prefix packages/runtime run check
npm --prefix packages/orchestrator run check
npm --prefix packages/cli run check
npm run build
git diff --check
```

Acceptance:

- A teacher can create a class, enroll students, publish an assignment, monitor
  multiple student sessions, assist one blocked student, review a submission,
  and export results without leaving OpenCortex.
- A student can launch or resume only their own assignment session and can see
  when a teacher is observing, assisting, controlling, or reviewing retained
  evidence.
- Classroom sharing never bypasses task/workbench policy, provider credential
  ownership, tenant/cohort scope, or ledger recording.
- Assignment-created sessions use the same Temporal, Herdr/direct driver,
  AgentClient, context-pack, skill, ledger, replay, and policy systems as all
  other OpenCortex sessions.
- Large classrooms remain usable because roster and oversight views use
  summaries, pagination, and lazy-loaded evidence.

Self-audit classroom privacy, role templates, retained evidence, share-mode
truthfulness, assignment idempotency, and policy inheritance. Resolve findings
in this slice before committing. Commit and push after the slice passes
validation.

### Slice 9: Migration Closure, Operational Hardening, and Local Release

Purpose:

Prove the combined system works from a clean install and an upgraded local
installation, then retire compatibility surfaces only when evidence permits.

Files expected to change:

- deployment Quadlets, environment examples, readiness scripts, and runbooks
- migration/compatibility documentation and release notes
- `README.md`, `docs/workbench-providers.md`, and
  `docs/multi-agent-oversight.md`
- end-to-end and deployment smoke tests

Implementation:

- Add the pinned Herdr prerequisite/service configuration, per-user setup,
  socket permissions, readiness probe, version reporting, and direct-driver
  rollback switch to the local deployment profile.
- Verify clean install and upgrade paths with migration backup, idempotent DB
  migrations, legacy JSON import, rollback boundaries, and retained evidence.
- Run an end-to-end matrix for Dex and Google OIDC, multiple users/tenants,
  local and Tailscale access, Claude/Codex/OpenCode readiness, direct and Herdr
  drivers, host outage, runtime/worker restart, context/skills, approval,
  handoff, replay, cost, classroom assignment flow, and policy denial.
- Exercise one realistic task from issue/manual creation through worktree,
  initial prompt, agent activity, review, commit/PR association, archival,
  memory capture, and replay.
- Add observability and alerts for stale hosts, workflow/driver divergence,
  duplicate command rejection, projection lag, ledger/outbox backlog, provider
  disconnect, budget threshold, and artifact failures.
- Measure list/detail/graph payload sizes and query latency with the large test
  fixture. Record explicit budgets in the runbook based on measured local
  hardware rather than invented targets.
- Update documentation to one current architecture and status. Remove the claim
  that OpenCode is the only workbench implementation. Mark each provider and
  feature as implemented, experimental, compatibility-only, or planned based on
  tested behavior.
- Keep compatibility routes for at least one released migration window. Add
  deprecation telemetry and a separately approved removal plan; do not remove
  them merely because the new UI no longer calls them.
- Tag/deploy only after a clean worktree passes the full validation suite. Push
  implementation commits before release; if further commits are required after
  a tag, cut a new release rather than claiming the old deployment contains
  them.

Tests:

- Clean database, upgraded database, repeated migration, legacy import, and
  rollback rehearsal.
- Multi-user and multi-tenant authorization through browser and API.
- Classroom clean-install and upgrade smoke tests: create cohort, enroll two
  students, publish assignment, launch/resume student sessions, teacher observe
  and assist, submit, review, export, and replay retained evidence.
- Restart/outage/reconnect scenarios using real Temporal and Herdr processes.
- Local-IP and Tailscale-IP browser smoke tests, including OIDC redirect URI and
  secure-cookie behavior.
- Data-retention expiration and legal/audit hold override where configured.
- Full CI suite and deployment readiness checks from a clean checkout.

Validation:

```bash
npm ci --include=dev --prefix packages/orchestrator
npm install --include=dev --package-lock=false --workspaces=false --prefix packages/workbench
npm install --include=dev --package-lock=false --workspaces=false --prefix packages/skills
npm install --include=dev --package-lock=false --workspaces=false --prefix packages/activity-ledger
npm install --include=dev --package-lock=false --workspaces=false --prefix packages/runtime
npm run check
npm --prefix packages/orchestrator run test:replay
npm --prefix packages/memory run check:empty-db
npm run build
npm run deploy:readiness
git diff --check
```

Acceptance:

- A clean local installation and an upgraded installation both complete the
  end-to-end task lifecycle.
- A clean local installation completes the classroom lifecycle with teacher and
  student accounts on local and Tailscale URLs.
- The authenticated UI is reachable through configured local and Tailscale
  addresses, and Google OIDC works through the same implementation as bundled
  Dex.
- Restarting runtime, Temporal workers, or the host does not silently duplicate
  work or lose durable task/review/history records.
- Operational docs identify authority, recovery, rollback, data retention,
  known limitations, and compatibility status accurately.

Self-audit release evidence, migration rollback, identity boundaries,
observability, and documentation truthfulness. Resolve findings before the
release commit. Commit and push, then deploy and verify the tagged release.

## Requirements Coverage

| Requirement area | Primary slices |
|---|---|
| Provider-neutral tasks/workbenches and migration | 1, 5, 9 |
| Multi-tenancy and roles | 1, 6, 8, 9 |
| Herdr terminal/process integration | 2, 3, 8, 9 |
| Worktrees and host fleet | 2, 7, 8, 9 |
| Durable Temporal orchestration | 3, 6, 8, 9 |
| ACP and Claude/Codex/OpenCode | 4, 8, 9 |
| Jira and project-system neutrality | 1, 5 |
| Context, memory, artifacts, and skills | 5, 6, 8, 9 |
| Ledger, replay, costs, and attribution | 6, 7, 8, 9 |
| Durable knowledge graph and graph-assisted retrieval | 5, 6, 7, 8, 9 |
| Handoff and governance | 6, 7, 8, 9 |
| Kepler-inspired oversight and review UX | 5, 7, 8, 9 |
| Classroom/cohort/assignment oversight | 1, 6, 8, 9 |
| Local/Tailscale deployment and OIDC | 9 |

## Open Concerns Requiring Explicit Resolution

- Select and pin a Herdr release only after its CLI/socket contract passes the
  Slice 2 fixtures on the reference Fedora host. Do not write a version into
  deployment files based only on documentation.
- Confirm whether one Herdr daemon per Unix user is operationally preferable to
  one privileged supervisor with strict per-user isolation. The default plan is
  per-user because it minimizes credential and process-boundary risk.
- Select an ACP library/transport after the Slice 4 protocol spike. The internal
  `AgentClient` contract must not expose library-specific types.
- Decide the release window for compatibility routes after usage telemetry is
  available. The first new release must keep them.
- Decide default retention periods with the operator before enabling terminal
  scrollback or complete provider transcripts. Default-disabled retention is
  the conservative implementation behavior.
- Provider-native handoff and provider-specific deep links are capabilities,
  not assumptions. The UI must report unavailable capability plainly.
- Decide the first classroom roster import source only when credentials or an
  operator-provided file exists. Slice 8 must support manual enrollment without
  requiring Google Classroom, LMS, SIS, Jira, or another external product.
- Decide whether classroom exports are instructor-only or also available to
  students for their own evidence package. Default behavior is student access
  to their own submission/replay manifest and teacher access to cohort-scoped
  exports.

These concerns do not block Slice 1. They become blocking acceptance decisions
in the slice that first changes the relevant production behavior.

## Out Of Scope Unless Separately Requested

- Reimplementing Claude, Codex, OpenCode, or Herdr conversation/terminal UIs.
- Copying Kepler source code, branding, proprietary assets, or private APIs.
- Making undocumented provider token or usage APIs mandatory.
- Exposing raw Herdr sockets or provider ports over the public web.
- Integrating with a specific LMS, SIS, Google Classroom, Canvas, Moodle, or
  gradebook API before the manual classroom model is working.
- Automatically deleting legacy session files, old routes, worktrees, branches,
  transcripts, artifacts, or ledger history.
- Rewriting the contents of the legacy Brain skills archive; that work follows
  the dedicated skills migration plan and feeds this plan's neutral importer.

## Recommended Execution Order

Execute Slices 1 through 9 in order. A later slice may begin only after the
previous slice's migration, compatibility, authorization, and recovery findings
are resolved and its commit is pushed. Do not batch several unvalidated slices
into one release-sized commit.

Before each slice:

1. Fetch `origin` and create or adopt a clean worktree from the latest intended
   parent branch.
2. Read repository instructions and dependency artifacts again; they may have
   changed since this plan was written.
3. Re-audit the prior slice's merged implementation so file paths and completed
   behavior in this plan remain accurate.
4. Implement only the current slice, including compatibility and tests.
5. Run the slice validation, self-audit requirements coverage, resolve findings,
   commit, and push.

After Slice 9, compare the deployed release against this plan and the complete
product requirements in `docs/multi-agent-oversight.md`. Any unimplemented item
must be listed as a finite follow-up with an owner and acceptance test; it must
not be silently relabeled complete or deferred.
