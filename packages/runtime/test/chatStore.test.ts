import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatStore } from "../src/chat/chatStore.js";
import type { AuthenticatedUser } from "../src/auth/types.js";
import type { CodeSession } from "../src/code/sessionLauncher.js";
import type { AppConfig } from "../src/config/config.js";

function config(): Pick<
  AppConfig,
  "DIWAN_DATA_DIR" | "DIWAN_ALLOWED_EMAIL_DOMAINS" | "DIWAN_LINUX_USER_PREFIX"
> {
  return {
    DIWAN_DATA_DIR: mkdtempSync(join(tmpdir(), "diwan-chat-")),
    DIWAN_ALLOWED_EMAIL_DOMAINS: ["acme.test"],
    DIWAN_LINUX_USER_PREFIX: "diwan-"
  };
}

function user(email: string): AuthenticatedUser {
  const local = email.split("@")[0];
  return {
    sub: `dev:${email}`,
    email,
    groups: ["TeamChatUsers", "OpenCodeUsers"],
    linuxUser: `diwan-${local}`
  };
}

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: "sess-1",
    createdAt: new Date().toISOString(),
    ownerEmail: "owner@acme.test",
    linuxUser: "diwan-owner",
    workspaceDir: "/home/diwan-owner/repos",
    port: 4100,
    urlPath: "/diwan/code/session/sess-1/",
    command: ["opencode", "web"],
    mode: "dry-run",
    ...overrides
  };
}

describe("ChatStore", () => {
  it("bootstraps general and keeps legacy messages available there", async () => {
    const cfg = config();
    writeFileSync(
      join(cfg.DIWAN_DATA_DIR, "chat.jsonl"),
      `${JSON.stringify({
        id: "legacy-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        authorEmail: "owner@acme.test",
        authorLinuxUser: "diwan-owner",
        body: "hello"
      })}\n`
    );

    const store = new ChatStore(cfg);
    const channels = store.listChannelsForUser(user("owner@acme.test"));
    expect(channels.map((channel) => channel.id)).toContain("general");

    const messages = await store.listMessages(
      "general",
      user("owner@acme.test")
    );
    expect(messages).toMatchObject([
      { id: "legacy-1", channelId: "general", body: "hello", kind: "user" }
    ]);
  });

  it("creates private session channels visible only to the owner", () => {
    const store = new ChatStore(config());
    const owner = user("owner@acme.test");
    const channel = store.ensureSessionChannel(session(), owner);

    expect(channel.name).toBe("New session");
    expect(channel.visibility).toBe("private");
    expect(store.listChannelsForUser(owner).map((item) => item.id)).toContain(
      channel.id
    );
    expect(
      store.listChannelsForUser(user("other@acme.test")).map((item) => item.id)
    ).not.toContain(channel.id);
  });

  it("can return all retained messages for a session channel", async () => {
    const store = new ChatStore(config());
    const owner = user("owner@acme.test");
    const channel = store.ensureSessionChannel(session(), owner);

    await store.appendMessage(channel.id, owner, "first");
    await store.appendMessage(channel.id, owner, "second");

    await expect(
      store.listMessages(channel.id, owner, Number.POSITIVE_INFINITY)
    ).resolves.toMatchObject([{ body: "first" }, { body: "second" }]);
  });

  it("renames a session channel when OpenCode provides a session name", () => {
    const store = new ChatStore(config());
    const owner = user("owner@acme.test");
    const channel = store.ensureSessionChannel(session(), owner);

    const changed = store.updateSessionChannelName(
      session({ name: "Greeting" })
    );

    expect(changed).toBe(true);
    expect(store.getChannelForSession(session())?.id).toBe(channel.id);
    expect(store.getChannelForSession(session())?.name).toBe("Greeting");
  });

  it("shares a session channel with another user", async () => {
    const store = new ChatStore(config());
    const owner = user("owner@acme.test");
    const channel = store.ensureSessionChannel(session(), owner);

    const shared = store.shareChannel(channel.id, "other@acme.test", owner);

    expect(shared.visibility).toBe("shared");
    expect(
      store.listChannelsForUser(user("other@acme.test")).map((item) => item.id)
    ).toContain(channel.id);

    await expect(
      store.appendMessage(channel.id, user("other@acme.test"), "joined")
    ).resolves.toMatchObject({ body: "joined", channelId: channel.id });
  });

  it("returns the same channel for the same live session id", () => {
    const store = new ChatStore(config());
    const owner = user("owner@acme.test");
    const first = session({ id: "sess-1" });
    const channel = store.ensureSessionChannel(first, owner);

    const restored = store.ensureSessionChannel(first, owner);

    expect(restored.id).toBe(channel.id);
    expect(store.getChannelForSession(first)?.id).toBe(channel.id);
  });

  it("creates a new channel for a new session in the same workspace", () => {
    const store = new ChatStore(config());
    const owner = user("owner@acme.test");
    const first = session({ id: "sess-1" });
    const channel = store.ensureSessionChannel(first, owner);
    store.shareChannel(channel.id, "other@acme.test", owner);
    store.archiveSessionChannel(first);

    const second = store.ensureSessionChannel(
      session({ id: "sess-2" }),
      owner
    );

    expect(second.id).not.toBe(channel.id);
    expect(second.archivedAt).toBeUndefined();
    expect(second.session?.sessionId).toBe("sess-2");
    expect(second.members.map((member) => member.email)).not.toContain(
      "other@acme.test"
    );
    expect(channel.archivedAt).toBeTruthy();
  });

  it("archives live session channels whose threads are no longer persisted", () => {
    const store = new ChatStore(config());
    const owner = user("owner@acme.test");
    const createdAt = new Date().toISOString();
    const oldThread = {
      id: "thread-old",
      openCodeSessionId: "ses_old",
      createdAt,
      lastSelectedAt: createdAt
    };
    const liveThread = {
      id: "thread-live",
      openCodeSessionId: "ses_live",
      createdAt,
      lastSelectedAt: createdAt
    };
    const stale = store.ensureSessionChannel(
      session({
        openCodeSessionId: "ses_old",
        activeThreadId: oldThread.id,
        threads: [oldThread]
      }),
      owner
    );
    const liveSession = session({
      openCodeSessionId: "ses_live",
      activeThreadId: liveThread.id,
      threads: [liveThread]
    });
    const live = store.ensureSessionChannel(liveSession, owner);

    const archived = store.archiveSessionChannelsNotMatchingThreads(liveSession);

    expect(archived.map((channel) => channel.id)).toEqual([stale.id]);
    expect(store.getChannelForUser(stale.id, owner)?.archivedAt).toBeTruthy();
    expect(store.getChannelForUser(stale.id, owner)?.session?.sessionId).toBeUndefined();
    expect(store.getChannelForUser(live.id, owner)?.archivedAt).toBeUndefined();
  });

  it("archives legacy unthreaded session channels once threads are known", () => {
    const store = new ChatStore(config());
    const owner = user("owner@acme.test");
    const legacy = store.ensureSessionChannel(session(), owner);
    const createdAt = new Date().toISOString();
    const thread = {
      id: "thread-live",
      openCodeSessionId: "ses_live",
      createdAt,
      lastSelectedAt: createdAt
    };

    const archived = store.archiveSessionChannelsNotMatchingThreads(
      session({
        openCodeSessionId: "ses_live",
        activeThreadId: thread.id,
        threads: [thread]
      })
    );

    expect(archived.map((channel) => channel.id)).toEqual([legacy.id]);
    expect(store.getChannelForUser(legacy.id, owner)?.archivedAt).toBeTruthy();
  });
});
