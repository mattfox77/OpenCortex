import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PairPromptStore } from "../src/pairPrompts/pairPromptStore.js";
import type { AuthenticatedUser } from "../src/auth/types.js";
import type { CodeSession } from "../src/code/sessionLauncher.js";

function user(email: string): AuthenticatedUser {
  return {
    sub: `dev:${email}`,
    email,
    groups: ["TeamChatUsers", "OpenCodeUsers"],
    linuxUser: email.split("@")[0]
  };
}

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: "sess-1",
    createdAt: "2026-06-10T00:00:00.000Z",
    ownerEmail: "owner@acme.test",
    linuxUser: "owner",
    workspaceDir: "/home/owner/repos",
    port: 4100,
    urlPath: "/diwan/code/session/sess-1/",
    command: ["opencode", "web"],
    mode: "dry-run",
    ...overrides
  };
}

function store(): PairPromptStore {
  return new PairPromptStore(mkdtempSync(join(tmpdir(), "diwan-pair-")));
}

describe("PairPromptStore", () => {
  it("freezes a ready snapshot and blocks edits while under review", () => {
    const prompts = store();
    const owner = user("owner@acme.test");
    const draft = prompts.create({
      session: session(),
      channelId: "session-channel",
      actor: owner,
      initialText: "draft text"
    });

    prompts.updateText(draft.id, owner, "final text");
    const ready = prompts.markReady(draft.id, owner);

    expect(ready.status).toBe("ready");
    expect(ready.reviewSnapshotText).toBe("final text");
    expect(ready.reviewSnapshotHash).toBeTruthy();
    expect(() => prompts.updateText(draft.id, owner, "late edit")).toThrow(
      /not editable/
    );
  });

  it("requires a different reviewer to reject or send a ready snapshot", () => {
    const prompts = store();
    const owner = user("owner@acme.test");
    const draft = prompts.create({
      session: session(),
      channelId: "session-channel",
      actor: owner,
      initialText: "please inspect this"
    });

    prompts.markReady(draft.id, owner);

    expect(() => prompts.reject(draft.id, owner)).toThrow(/requester/);
    expect(() => prompts.startSending(draft.id, owner)).toThrow(/requester/);
    expect(prompts.reject(draft.id, user("reviewer@acme.test")).status).toBe(
      "rejected"
    );
  });

  it("persists lifecycle events across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "diwan-pair-"));
    const owner = user("owner@acme.test");
    const first = new PairPromptStore(dir);
    const draft = first.create({
      session: session(),
      channelId: "session-channel",
      actor: owner,
      initialText: "persist me"
    });
    first.markReady(draft.id, owner);

    const second = new PairPromptStore(dir);
    expect(second.get(draft.id)).toMatchObject({
      status: "ready",
      reviewSnapshotText: "persist me"
    });
  });
});
