import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DirectProcessHostSessionDriver,
  HerdrHostSessionDriver,
  assertPathWithinRoots,
  selectHostForSession,
} from "../dist/index.js";

test("direct-process driver probes normalized host capabilities", async () => {
  const driver = new DirectProcessHostSessionDriver({
    driverVersion: "test-version",
    labels: ["fedora", "local"],
    pathRoots: [process.cwd()],
    providers: [{ providerId: "opencode", ready: true }],
  });

  assert.deepEqual(await driver.probe(), {
    driverId: "direct-process",
    driverVersion: "test-version",
    available: true,
    providers: [{ providerId: "opencode", ready: true }],
    labels: ["fedora", "local"],
    pathRoots: [process.cwd()],
  });
});

test("workspace creation refuses paths outside allowed roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencortex-host-runtime-"));
  const driver = new DirectProcessHostSessionDriver({ pathRoots: [root] });

  try {
    const workspace = await driver.createWorkspace({
      workspaceId: "workspace-1",
      path: join(root, "project"),
      pathRoots: [root],
    });
    assert.equal(workspace.workspaceId, "workspace-1");
    assert.equal(workspace.path, join(root, "project"));
    assert.throws(
      () => assertPathWithinRoots(join(root, "..", "escape"), [root]),
      /escapes allowed roots/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct-process driver starts commands and reads bounded output", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencortex-host-runtime-"));
  const driver = new DirectProcessHostSessionDriver({ pathRoots: [root] });

  try {
    const workspace = await driver.createWorkspace({
      workspaceId: "workspace-2",
      path: root,
      pathRoots: [root],
    });
    const pane = await driver.createPane(workspace, "test pane");
    const handle = await driver.startCommand(pane, {
      workspace,
      command: [
        process.execPath,
        "-e",
        "process.stdout.write('0123456789abcdef'); process.stderr.write('err');",
      ],
    });

    await waitForExit(driver, handle.sessionId);
    const output = await driver.readOutput(handle.sessionId, 8);
    assert.equal(output.stdout, "89abcdef");
    assert.equal(output.stderr, "err");
    assert.equal(output.truncated, true);
    assert.equal(output.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct-process driver can wait for a detached logged TCP process", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencortex-host-runtime-"));
  const driver = new DirectProcessHostSessionDriver({ pathRoots: [root] });
  const port = await freePort();
  const logPath = join(root, "session.log");

  try {
    const workspace = await driver.createWorkspace({
      workspaceId: "workspace-logged",
      path: root,
      pathRoots: [root],
    });
    const pane = await driver.createPane(workspace);
    const handle = await driver.startCommand(pane, {
      workspace,
      command: [
        process.execPath,
        "-e",
        [
          "const net = require('node:net')",
          "process.stdout.write('logged-ready')",
          `net.createServer().listen(${port}, '127.0.0.1')`,
          "setInterval(() => {}, 1000)",
        ].join(";"),
      ],
      detached: true,
      outputPath: logPath,
      readiness: {
        type: "tcp-port",
        port,
        timeoutMs: 3000,
      },
      unref: true,
    });
    assert.equal((await driver.snapshot(handle.sessionId)).status, "running");
    assert.match(readFileSync(logPath, "utf8"), /logged-ready/);
    await driver.archive(handle.sessionId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct-process driver stops and archives sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencortex-host-runtime-"));
  const driver = new DirectProcessHostSessionDriver({ pathRoots: [root] });

  try {
    const workspace = await driver.createWorkspace({
      workspaceId: "workspace-3",
      path: root,
      pathRoots: [root],
    });
    const pane = await driver.createPane(workspace);
    const handle = await driver.startCommand(pane, {
      workspace,
      command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
    });

    await driver.stop(handle.sessionId);
    assert.equal((await driver.snapshot(handle.sessionId)).status, "stopped");
    await driver.archive(handle.sessionId);
    assert.equal((await driver.snapshot(handle.sessionId)).status, "archived");
    assert.equal((await driver.recover()).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("herdr driver reports unavailable when the CLI cannot be probed", async () => {
  const driver = new HerdrHostSessionDriver({
    runCommand: async () => {
      throw new Error("missing herdr");
    },
  });
  const probe = await driver.probe();
  assert.equal(probe.driverId, "herdr");
  assert.equal(probe.available, false);
  assert.equal(probe.diagnostics.reason, "missing herdr");
});

test("herdr driver normalizes supported CLI JSON responses", async () => {
  const calls = [];
  const driver = new HerdrHostSessionDriver({
    linuxUser: "owner",
    socketPath: "/run/user/1001/herdr.sock",
    pathRoots: ["/home/owner/repos"],
    providers: [{ providerId: "opencode", ready: true }],
    runCommand: async args => {
      calls.push(args);
      if (args.join(" ") === "--version") return "herdr 0.9.0";
      if (args.join(" ") === "api schema --json") {
        return { protocol_version: 10 };
      }
      if (args[0] === "workspace") {
        return {
          workspace: {
            workspace_id: "workspace-1",
            cwd: "/home/owner/repos/OpenCortex",
          },
        };
      }
      if (args[0] === "tab") {
        return { pane: { pane_id: "w1:p2", workspace_id: "workspace-1" } };
      }
      if (args[0] === "pane" && args[1] === "run") {
        return { result: { pane_id: "w1:p2", pid: 1234 } };
      }
      if (args[0] === "pane" && args[1] === "read") {
        return { result: { text: "0123456789abcdef" } };
      }
      if (args[0] === "pane" && args[1] === "get") {
        return {
          pane: {
            pane_id: "w1:p2",
            workspace_id: "workspace-1",
            state: "idle",
            agent_session: { provider: "opencode", id: "native-1" },
            ignored_future_field: true,
          },
        };
      }
      if (args[0] === "pane" && args[1] === "list") {
        return {
          panes: [
            {
              pane_id: "w1:p2",
              workspace_id: "workspace-1",
              state: "running",
            },
          ],
        };
      }
      if (args[0] === "pane" && args[1] === "close") {
        return { result: { closed: true } };
      }
      if (args[0] === "pane" && args[1] === "send-input") {
        return { result: { sent: true } };
      }
      throw new Error(`unexpected command ${args.join(" ")}`);
    },
  });

  const probe = await driver.probe();
  assert.equal(probe.available, true);
  assert.equal(probe.driverVersion, "herdr 0.9.0");
  assert.equal(probe.diagnostics.linuxUser, "owner");
  assert.equal(probe.diagnostics.socketPath, "/run/user/1001/herdr.sock");
  const workspace = await driver.createWorkspace({
    workspaceId: "workspace-1",
    path: "/home/owner/repos/OpenCortex",
    pathRoots: ["/home/owner/repos"],
  });
  const pane = await driver.createPane(workspace, "Coding");
  const handle = await driver.startCommand(pane, {
    workspace,
    command: ["opencode", "web"],
  });
  await driver.sendInput(handle.sessionId, "hello");
  const output = await driver.readOutput(handle.sessionId, 8);
  const snapshot = await driver.snapshot(handle.sessionId);
  const recovered = await driver.recover();
  await driver.archive(handle.sessionId);

  assert.equal(handle.sessionId, "w1:p2");
  assert.equal(output.stdout, "89abcdef");
  assert.equal(output.truncated, true);
  assert.equal(snapshot.nativeSession.id, "native-1");
  assert.equal(snapshot.raw.ignored_future_field, true);
  assert.equal(recovered.length, 1);
  assert(calls.some(args => args.includes("send-input")));
});

test("herdr driver rejects unsupported protocol versions", async () => {
  const driver = new HerdrHostSessionDriver({
    runCommand: async args => {
      if (args.join(" ") === "--version") return "herdr 0.8.0";
      if (args.join(" ") === "api schema --json") {
        return { protocol_version: 9 };
      }
      throw new Error("unexpected");
    },
  });
  const probe = await driver.probe();
  assert.equal(probe.available, false);
  assert.equal(probe.diagnostics.protocolVersion, 9);
  assert.equal(probe.diagnostics.pinnedProtocolVersion, 10);
});

test("host selection is deterministic and explains rejected hosts", () => {
  const result = selectHostForSession(
    [
      {
        id: "z-host",
        status: "online",
        labels: ["gpu"],
        capabilities: [
          {
            subject: "dev:owner@acme.test",
            linuxUser: "owner",
            providers: [{ providerId: "opencode", ready: true }],
          },
        ],
      },
      {
        id: "a-host",
        status: "online",
        labels: ["fedora"],
        pathRoots: ["/srv/repos"],
        capabilities: [
          {
            subject: "dev:owner@acme.test",
            linuxUser: "owner",
            providers: [{ providerId: "opencode", ready: true }],
          },
        ],
      },
      {
        id: "b-host",
        status: "stale",
      },
    ],
    {
      subject: "dev:owner@acme.test",
      linuxUser: "owner",
      providerId: "opencode",
      requiredLabels: ["fedora"],
      repositoryPath: "/srv/repos/OpenCortex",
    },
  );

  assert.equal(result.selected.id, "a-host");
  assert.deepEqual(result.rejected, []);
});

test("host selection reports explicit host and readiness failures", () => {
  const result = selectHostForSession(
    [
      {
        id: "a-host",
        status: "online",
        labels: ["fedora"],
        capabilities: [],
      },
      {
        id: "b-host",
        status: "offline",
      },
    ],
    {
      subject: "dev:owner@acme.test",
      linuxUser: "owner",
      providerId: "opencode",
      explicitHostId: "b-host",
    },
  );

  assert.equal(result.selected, undefined);
  assert.deepEqual(result.rejected, [
    { hostId: "a-host", reason: "not_explicit_host" },
    { hostId: "b-host", reason: "host_offline" },
  ]);
});

async function waitForExit(driver, sessionId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const snapshot = await driver.snapshot(sessionId);
    if (snapshot?.status === "exited") {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for host session exit");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate port"));
        return;
      }
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}
