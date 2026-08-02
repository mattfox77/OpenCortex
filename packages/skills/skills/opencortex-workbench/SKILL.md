---
name: opencortex-workbench
description: Work inside OpenCortex provisioned coding sessions. Use when an agent is operating in a Cortex Workbench/OpenCode/Codex environment and needs to respect provisioned paths, per-user isolation, session metadata, and review-oriented workflow expectations.
---

# OpenCortex Workbench

Treat the provisioned session as a per-user Linux workspace. Work in the
repository or workspace the user selected, and avoid writing outside the user's
home or configured workspace root unless the task explicitly requires it.

## Session Workflow

1. Inspect the repository before editing.
2. Keep changes scoped to the requested task.
3. Run the narrowest useful checks, then broader checks when shared behavior is
   touched.
4. Capture durable findings to OpenCortex memory when they would help later
   sessions.

## Review Gates

Some actions are mediated by OpenCortex review or pair-prompt workflows. When a
command, prompt, or memory change needs approval, leave enough context for a
reviewer to decide:

- what will change
- why it is needed
- how it was validated
- what rollback looks like

## Boundaries

- Do not assume cloud infrastructure is available; OpenCortex infrastructure is
  self-hosted by default.
- Do not rely on DSN or BrainTrust-specific paths.
- Use `cortex` commands for memory, sessions, workflows, and activity reports.
