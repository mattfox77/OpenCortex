import test from "node:test";
import assert from "node:assert/strict";
import { assertAgentCapabilities } from "@opencortex/agent-client";
import {
  ClaudeCodeWorkbenchProvider,
  CodexWorkbenchProvider,
  OpenCodeWorkbenchProvider,
} from "../dist/index.js";

const launchRequest = {
  user: { email: "owner@acme.test", linuxUser: "owner" },
  sessionId: "workspace-owner",
  port: 4873,
  basePath: "/diwan",
  dataDir: "/var/lib/opencortex",
  binaryPath: "/usr/local/bin/provider",
  mode: "sudo",
  initialPrompt: "Start from Jira OC-123 and summarize the plan.",
  displayName: "OpenCortex OC-123",
  model: "claude-sonnet-4-5",
  effort: "high",
  permissionMode: "plan",
  account: { id: "work", displayName: "Work account" },
};

test("workbench providers expose valid agent-client capabilities", () => {
  for (const provider of [
    new OpenCodeWorkbenchProvider(),
    new CodexWorkbenchProvider(),
    new ClaudeCodeWorkbenchProvider(),
  ]) {
    assert.doesNotThrow(() => assertAgentCapabilities(provider.capabilities()));
  }
});

test("claude-code launch uses remote control with the rendered initial prompt", () => {
  const provider = new ClaudeCodeWorkbenchProvider();
  const plan = provider.planLaunch(launchRequest);

  assert.equal(plan.providerId, "claude-code");
  assert.equal(plan.workspaceDir, "/home/owner/repos");
  assert.equal(plan.urlPath, "https://claude.ai/code");
  assert.deepEqual(plan.command, [
    "/usr/local/bin/provider",
    "--remote-control",
    "OpenCortex OC-123",
    "--model",
    "claude-sonnet-4-5",
    "--effort",
    "high",
    "--permission-mode",
    "plan",
    "Start from Jira OC-123 and summarize the plan.",
  ]);
  assert.deepEqual(plan.launchContext, {
    initialPrompt: "Start from Jira OC-123 and summarize the plan.",
    model: "claude-sonnet-4-5",
    effort: "high",
    permissionMode: "plan",
    account: { id: "work", displayName: "Work account" },
  });
  assert.equal(plan.environment.HOME, "/home/owner");
  assert.equal(plan.environment.CLAUDE_CONFIG_DIR, "/home/owner/.claude");
  assert.ok(plan.runtimeDirs.includes("/home/owner/.claude/projects"));
  assert.equal(plan.readiness, undefined);
  assert.equal(plan.supportsOpenCodeThreads, false);
});

test("opencode launch remains loopback proxied behind OpenCortex auth", () => {
  const provider = new OpenCodeWorkbenchProvider();
  const plan = provider.planLaunch(launchRequest);

  assert.equal(plan.providerId, "opencode");
  assert.deepEqual(plan.command, [
    "/usr/local/bin/provider",
    "web",
    "--hostname",
    "127.0.0.1",
    "--port",
    "4873",
  ]);
  assert.deepEqual(plan.launchContext, {
    initialPrompt: "Start from Jira OC-123 and summarize the plan.",
    model: "claude-sonnet-4-5",
    effort: "high",
    permissionMode: "plan",
    account: { id: "work", displayName: "Work account" },
  });
  assert.equal(plan.urlPath, "/diwan/code/session/workspace-owner/");
  assert.deepEqual(plan.readiness, {
    type: "tcp-port",
    port: 4873,
    timeoutMs: 8000,
  });
  assert.equal(plan.supportsOpenCodeThreads, true);
});
