import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DirectProcessHostSessionDriver,
  HerdrHostSessionDriver,
  assertPathWithinRoots,
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

test("herdr driver reports unavailable until a socket contract is configured", async () => {
  const driver = new HerdrHostSessionDriver();
  const probe = await driver.probe();
  assert.equal(probe.driverId, "herdr");
  assert.equal(probe.available, false);
  await assert.rejects(() => driver.recover(), /not configured/);
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
