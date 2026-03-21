# 🧠 Open Cortex

**Distributed AI agent orchestration for [Open Brain](https://github.com/NateBJones-Projects/OB1) — powered by [Temporal.io](https://temporal.io)**

Open Brain gave your AI agents a shared memory. Open Cortex gives them a coordination layer — so multiple CLI workers (Claude Code, OpenClaw, or anything MCP-capable) can run across different machines, share one brain, and never drop a task.

```
┌─────────────────────────────────────────────────────┐
│              TEMPORAL SERVICE                        │
│    (durable execution — tasks survive crashes)       │
│                                                      │
│   Task Queue: cortex-tasks   Task Queue: cortex-code │
└──────────┬──────────────────────────┬────────────────┘
           │                          │
     ┌─────▼─────┐            ┌──────▼──────┐
     │ WORKER #1  │            │  WORKER #2   │
     │ Mac Studio │            │  VPS         │
     │ Claude Code│            │  Claude Code │
     └─────┬──────┘            └──────┬───────┘
           │                          │
           └──────────┬───────────────┘
                      │
              ┌───────▼───────┐
              │  OPEN BRAIN   │
              │  (Supabase)   │
              │               │
              │  thoughts     │
              │  workers      │
              │  task_ledger  │
              └───────────────┘
```

---

## Why This Exists

Open Brain solved the AI memory problem. Any AI you connect — Claude, ChatGPT, Cursor — reads from and writes to the same personal knowledge base. Context compounds across tools and sessions.

But memory and action are different problems.

When you need AI to actually *do things* — deploy code, review a PR, monitor a system overnight, execute a multi-step workflow — you quickly hit the limits of current tooling:

- **Nothing survives a crash.** If your agent dies mid-task (rate limit, laptop sleep, process kill), the task is gone. You start over and hope the LLM picks up where it left off.
- **Each agent is an island.** OpenClaw, Ralph loop, Gas Town, Multiclaude — they're powerful on a single machine. But running multiple agents across machines means manual coordination, per-agent memory silos, and no guarantees about exactly-once execution.
- **There's no reliable way to pause and resume.** You either babysit the agent or run it fully autonomous. There's no middle ground where the agent plans, waits for your approval, then executes — and that wait survives you closing your laptop.

Open Cortex closes these gaps by combining two systems that each solve half the problem:

| System | What It Provides | What It's Missing |
|---|---|---|
| **Open Brain** | Shared semantic memory across all agents | Coordination, task routing, durability |
| **Temporal.io** | Durable execution, distributed task queues, fault tolerance | Shared AI context, agent memory |
| **Open Cortex** | **Both — together** | — |

Temporal is the same infrastructure Snap, Netflix, Coinbase, and Stripe use for workflows that cannot fail. It automatically persists state after every step. If a machine goes down, Temporal replays the entire history on a different machine and picks up exactly where it left off. That property — *durable execution* — is what's been missing from every AI agent orchestrator on the market.

---

## Three Things Open Cortex Adds

### 1. Durable Task Execution

Start a task on Monday. Worker crashes on Tuesday. A different worker picks it up on Tuesday and continues from the exact step where it failed. No re-running completed work. No context loss. This is Temporal's core guarantee, applied to AI agent workflows.

### 2. Distributed Workers

Run Claude Code on your Mac Studio for heavy coding tasks. Run another instance on a VPS that has production network access for deployments. Run a third on your laptop for research. Each worker polls task queues and picks up work as it arrives. Temporal handles the routing, retries, and load distribution.

### 3. Brain-Powered Context Sharing

Every worker reads from and writes to the same Open Brain. Worker #1 discovers a vulnerability during a code review and captures it. Worker #2 starts a related deployment task an hour later, searches the brain first, and finds Worker #1's discovery — then adjusts its approach before touching production. No shared filesystem. No Slack channel. No human forwarding context. The brain is the connective tissue.

This third point is what separates Open Cortex from just "Temporal for AI." Temporal gives you coordination. Open Brain gives you context. The combination means your agents don't just avoid dropping tasks — they get smarter as a fleet.

---

## What This Solves

| Problem | How Open Cortex Handles It |
|---|---|
| Agent crashes mid-task | Temporal replays from last checkpoint on any available worker |
| Tasks stuck on one machine | Workers on different machines poll shared task queues |
| Agents don't share context | Every worker reads/writes the same Open Brain |
| No audit trail | Task ledger records every attempt, result, and failure |
| Can't approve tasks remotely | Temporal Signals let you approve from Slack, phone, or CLI |
| Long tasks need babysitting | Durable timers run for hours, days, or weeks unattended |

---

## How It Works

### The Execution Loop

Open Cortex runs a loop structurally similar to the [Ralph Wiggum technique](https://github.com/frankbria/ralph-claude-code) — hard context resets between iterations, fresh reasoning every cycle — but made crash-proof through Temporal's durable execution:

```
1. Search Open Brain for relevant context
2. Ask Claude Code to build a step-by-step plan
3. (Optional) Pause for human approval via Temporal Signal
4. Execute the plan iteratively
   └─ Each iteration:
      ├─ Capture important findings to Open Brain
      ├─ Store intermediate results in workflow context
      └─ Check if the task is complete
5. Capture summary to Open Brain, update the task ledger
```

If a worker crashes at step 4, iteration 3 — Temporal replays the workflow history on another worker and resumes at step 4, iteration 3. No work is repeated. No context is lost.

### Architecture (Temporal Concepts)

Open Cortex follows [Temporal's standard architecture](https://temporal.io/how-it-works):

- **Workflows** (`src/workflows/`) — Deterministic functions defining the orchestration logic. Temporal makes them indestructible by replaying from event history on failure.
- **Activities** (`src/activities/`) — Non-deterministic functions that perform real work: invoking Claude Code, searching the brain, sending notifications. These can fail and automatically retry.
- **Workers** (`src/worker.ts`) — Processes that poll task queues and execute workflows and activities. Deploy one per machine.

### Database Extensions

Three new tables extend your existing Open Brain Supabase database:

- **`worker_registry`** — Each CLI instance registers itself with its name, capabilities, task queues, and machine info. Heartbeats track online status.
- **`task_ledger`** — Audit trail for every task: workflow ID, status, input/output, timestamps, errors. Query this instead of digging through logs.
- **`workflow_context`** — Shared scratchpad for multi-step workflows. Workers leave notes for each other mid-execution ("staging deploy found a missing env var — here's the fix").

### Signals, Queries, and Remote Control

Temporal's message-passing primitives let you interact with running workflows from anywhere:

```typescript
// Approve a task that's waiting for review
import { approve } from './src/client';
await approve('cortex-task-12345', true, 'Looks good, ship it');

// Check what a task is doing right now
import { getStatus } from './src/client';
const status = await getStatus('cortex-task-12345');
// → { phase: 'executing', currentStep: 'Iteration 3/10', ... }

// Send feedback to redirect a running task
import { sendFeedback } from './src/client';
await sendFeedback('cortex-task-12345', 'Focus on the auth module first');
```

---

## Patterns This Enables

**Specialist routing.** Route code tasks to your Mac Studio (fast CPU, big RAM). Route deployments to your VPS (production network access). Route research to your laptop. Different machines, different capabilities, one coordination layer.

**Human-in-the-loop approval gates.** The agent plans, then pauses for your approval. The pause is durable — close your laptop, approve from your phone tomorrow. The workflow is still there, waiting. This is a middle ground between full autonomy and constant babysitting.

**Cross-agent context sharing.** Agent A reviews a PR and captures a finding to the brain. Agent B, running on a different machine, picks up a deployment task an hour later. It searches the brain, finds Agent A's finding, and adjusts its strategy. No manual context forwarding required.

**Long-running monitors.** Start a workflow that checks your API health every 30 minutes, indefinitely. It captures findings to your brain and alerts you when something goes wrong. Uses Temporal's `continueAsNew` to avoid unbounded history growth.

---

## Comparison

| Capability | OpenClaw | Ralph Loop | Gas Town | **Open Cortex** |
|---|---|---|---|---|
| Survives worker crash | ✗ | ✗ | ✗ | ✅ Temporal replay |
| Distributed across machines | Dashboard only | ✗ | Single host | ✅ Task queues |
| Shared semantic memory | Per-agent files | ✗ | ✗ | ✅ Open Brain |
| Exactly-once execution | ✗ | ✗ | ✗ | ✅ Temporal guarantees |
| Human-in-the-loop | Manual | ✗ | ✗ | ✅ Durable Signals |
| Observable execution history | Logs | Logs | Logs | ✅ Temporal UI |
| Long-running (days/weeks) | ✗ | ✗ | ✗ | ✅ Durable timers |

Open Cortex doesn't replace these tools. It adds the reliability and coordination layer they're missing. You can use OpenClaw or Claude Code as the underlying CLI agent — Open Cortex orchestrates on top.

---

## Prerequisites

- **Open Brain running** — follow the [Open Brain setup guide](https://github.com/NateBJones-Projects/OB1/blob/main/docs/01-getting-started.md) first
- **Node.js 20+**
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **Docker** — for the local Temporal dev server (or use [Temporal Cloud](https://temporal.io/cloud) for production)

---

## Quick Start (15 minutes)

### 1. Start the Temporal dev server

```bash
npx temporal server start-dev --ui-port 8233
```

Open http://localhost:8233 to verify the Temporal UI is running.

### 2. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/open-cortex.git
cd open-cortex
npm install
```

### 3. Extend your Open Brain database

Open **Supabase dashboard → SQL Editor → New query**, paste the contents of [`sql/001-cortex-tables.sql`](sql/001-cortex-tables.sql), and click **Run**.

This adds three tables alongside your existing `thoughts` table: `worker_registry`, `task_ledger`, and `workflow_context`.

### 4. Configure environment

```bash
cp .env.example .env
```

Fill in your existing Open Brain credentials:

```env
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
OPENROUTER_API_KEY=your-openrouter-key
TEMPORAL_ADDRESS=localhost:7233

WORKER_NAME=my-first-worker
TASK_QUEUES=cortex-tasks
CAPABILITIES=coding,research
```

### 5. Start a worker

```bash
npm run worker
```

```
🧠 Open Cortex Worker "my-first-worker" registered
   Task Queues: cortex-tasks
   Capabilities: coding, research
🚀 Polling for tasks...
```

### 6. Run a task

In a second terminal:

```bash
npm run task -- "Review the README for clarity and suggest three improvements"
```

Watch the workflow execute in the Temporal UI at http://localhost:8233.

### 7. Add more workers (any machine)

```bash
WORKER_NAME=worker-2 TASK_QUEUES=cortex-tasks,cortex-code npm run worker
```

Both workers now compete for tasks on shared queues. Temporal routes work to whichever picks it up first.

---

## Examples

### Distributed Code Review

```bash
# Worker on Mac Studio — handles code-heavy tasks
WORKER_NAME=mac-studio TASK_QUEUES=cortex-code npm run worker

# Worker on VPS — handles deployments
WORKER_NAME=deploy-vps TASK_QUEUES=cortex-deploy npm run worker

# Start a review on the code queue
npm run task -- --queue cortex-code \
  "Review src/auth/ for SQL injection, XSS, and improper token handling"
```

### Long-Running System Monitor

```bash
npm run monitor -- \
  --description "Check production API health and response times" \
  --interval "30 minutes"
```

Runs indefinitely. Captures findings to your Open Brain. Alerts you when something looks wrong.

### Approval-Gated Deployment

```bash
npm run task -- --approval --queue cortex-deploy \
  "Deploy latest main to staging, run smoke tests, report results"
```

The workflow builds a plan, sends you a notification, and waits for your approval. Approve from Slack, your phone, or the CLI. The wait is durable — it survives restarts.

---

## Repo Structure

```
open-cortex/
├── README.md                    ← You are here
├── docs/
│   ├── architecture.md          ← Full architecture deep-dive with extended code
│   └── article.md               ← Narrative companion piece
├── sql/
│   └── 001-cortex-tables.sql    ← Run this in Supabase SQL Editor
├── src/
│   ├── workflows/
│   │   └── cortex.ts            ← Temporal workflows (task loop + monitor)
│   ├── activities/
│   │   └── index.ts             ← CLI execution, brain search, notifications
│   ├── worker.ts                ← Worker process (one per machine)
│   └── client.ts                ← Client helpers (start tasks, send signals)
├── examples/
│   ├── code-review.ts           ← Approval-gated distributed code review
│   ├── monitor.ts               ← Long-running system monitor
│   └── multi-worker.sh          ← Start 3 workers on different queues
├── scripts/
│   └── start-task.ts            ← CLI entry point for starting tasks
├── .env.example
├── package.json
├── tsconfig.json
└── LICENSE
```

---

## Roadmap

- [ ] **Temporal Schedules** — Recurring tasks: daily standups, weekly reviews, nightly deploys
- [ ] **Child workflows** — Parallel sub-workflows distributed across workers
- [ ] **MCP tools** — `cortex_start_task` and `cortex_fleet_status` as Open Brain MCP server extensions
- [ ] **Dashboard** — React UI reading `worker_registry` + `task_ledger` + Temporal API
- [ ] **Slack bot** — Approve/reject and check fleet status from Slack
- [ ] **OpenClaw worker type** — Use OpenClaw as a worker alongside Claude Code

---

## Contributing

Extensions, new worker types, workflow templates, and documentation improvements are all welcome.

1. Fork the repo
2. Create a feature branch
3. Submit a PR with a clear description of what changed and why

This project follows the same contribution model as [Open Brain](https://github.com/NateBJones-Projects/OB1).

---

## Community

- **[Open Brain Discord](https://discord.gg/Cgh9WJEkeG)** — `#open-cortex` channel
- **[Nate's Substack](https://natesnewsletter.substack.com)** — Where Open Brain started
- **[Temporal Community Slack](https://temporal.io/slack)** — For Temporal-specific questions

---

## License

MIT

---

*Built on [Open Brain](https://github.com/NateBJones-Projects/OB1) by Nate B. Jones and the [Temporal.io](https://temporal.io) durable execution platform.*
