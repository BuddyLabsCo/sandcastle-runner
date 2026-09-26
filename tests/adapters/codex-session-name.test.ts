import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renameCodexSession } from "../../src/adapters/codex-session-name.ts";

const spawn = childProcess.spawn;
const fixture = fileURLToPath(
  new URL("../support/codex-session-name-server.ts", import.meta.url),
);

// Regression: a rename must target the persisted probe and await its acknowledgement.
// Seam: the exported helper at the external stdio process boundary, not the Run.
// Existing adapter tests do not exercise Codex's naming protocol or process ownership.
test("renames the persisted probe through initialized stdio and reaps the server", async (t) => {
  let server: ChildProcess | undefined;
  t.mock.method(
    childProcess,
    "spawn",
    (file: string, args: string[], options: childProcess.SpawnOptions) => {
      assert.match([file, ...args].join(" "), /codex/iu);
      assert.match(args.join(" "), /app-server/u);
      assert.equal(options.cwd, process.cwd());
      assert.equal(options.env, undefined);
      assert.notEqual(options.shell, true);
      server = spawn(process.execPath, [fixture], options);
      return server;
    },
  );
  t.after(() => server?.kill("SIGKILL"));

  await renameCodexSession(
    "persisted-probe-id",
    'Issue #169: "renamed"\n\u4f1a\u8bdd',
    {
      worktree: process.cwd(),
      timeoutMs: 2000,
      signal: new AbortController().signal,
    },
  );

  assert.ok(server);
  assert.ok(
    server.exitCode !== null || server.signalCode !== null,
    "server must be reaped before returning",
  );
});

// Regression: malformed rename acknowledgements must not report naming success.
// Seam: the public helper with only the external stdio process replaced.
// The happy-path test cannot detect acceptance of a non-object protocol result.
test("rejects a malformed rename acknowledgement and reaps the server", async (t) => {
  let server: ChildProcess | undefined;
  t.mock.method(
    childProcess,
    "spawn",
    (_file: string, _args: string[], options: childProcess.SpawnOptions) => {
      server = spawn(process.execPath, [fixture, "invalid-ack"], options);
      return server;
    },
  );
  t.after(() => server?.kill("SIGKILL"));

  await assert.rejects(
    renameCodexSession(
      "persisted-probe-id",
      'Issue #169: "renamed"\n\u4f1a\u8bdd',
      {
        worktree: process.cwd(),
        timeoutMs: 2000,
        signal: new AbortController().signal,
      },
    ),
    /Invalid Codex app-server acknowledgement/u,
  );
  assert.ok(server);
  assert.ok(
    server.exitCode !== null || server.signalCode !== null,
    "server must be reaped before rejection",
  );
});

// Regressions: RPC rejection, corrupt output, early exit, and missing ACK must
// reject only after reaping; neither notifications nor unrelated IDs are ACKs.
// Seam: public helper, substituting only the external process. Happy-path and
// malformed-result checks do not protect these independent failure modes.
for (const [scenario, expected] of [
  ["initialize-error", /Initialization rejected/u],
  ["rename-error", /Unknown thread/u],
  ["malformed-json", /JSON/u],
  ["exit", /exited before rename acknowledgement \(7\)/u],
  ["initialize-timeout", /rename timed out/u],
  ["no-ack", /rename timed out/u],
] as const) {
  test(`rejects ${scenario} and reaps the app server`, async (t) => {
    let server: ChildProcess | undefined;
    t.mock.method(
      childProcess,
      "spawn",
      (_file: string, _args: string[], options: childProcess.SpawnOptions) => {
        server = spawn(process.execPath, [fixture, scenario], options);
        return server;
      },
    );
    t.after(() => server?.kill("SIGKILL"));
    await assert.rejects(
      renameCodexSession(
        "persisted-probe-id",
        'Issue #169: "renamed"\n\u4f1a\u8bdd',
        {
          worktree: process.cwd(),
          timeoutMs: 500,
          signal: new AbortController().signal,
        },
      ),
      expected,
    );
    assert.ok(server);
    assert.ok(
      server.exitCode !== null || server.signalCode !== null,
      "server must be reaped before rejection",
    );
  });
}

// Regression: cancelling while waiting for the rename ACK must stop the child,
// not wait for the timeout. Existing failures do not exercise AbortSignal.
test("cancels an in-flight rename and reaps the app server", async (t) => {
  const controller = new AbortController();
  const reason = new Error("Operator cancelled");
  let server: ChildProcess | undefined;
  t.mock.method(
    childProcess,
    "spawn",
    (_file: string, _args: string[], options: childProcess.SpawnOptions) => {
      server = spawn(process.execPath, [fixture, "no-ack"], options);
      server.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("thread/name/updated"))
          controller.abort(reason);
      });
      return server;
    },
  );
  t.after(() => server?.kill("SIGKILL"));
  await assert.rejects(
    renameCodexSession(
      "persisted-probe-id",
      'Issue #169: "renamed"\n\u4f1a\u8bdd',
      {
        worktree: process.cwd(),
        timeoutMs: 2000,
        signal: controller.signal,
      },
    ),
    { message: "Codex session rename aborted", cause: reason },
  );
  assert.ok(server);
  assert.ok(
    server.exitCode !== null || server.signalCode !== null,
    "server must be reaped before cancellation returns",
  );
});

// Regression: an already-cancelled operation must not launch a process at all.
// The in-flight cancellation test does not protect this pre-launch boundary.
test("does not launch a server for an already-cancelled rename", async (t) => {
  t.mock.method(childProcess, "spawn", () =>
    assert.fail("Cancelled rename launched a process"),
  );
  const reason = new Error("Already cancelled");
  await assert.rejects(
    renameCodexSession("persisted-probe-id", "Unused", {
      worktree: process.cwd(),
      timeoutMs: 2000,
      signal: AbortSignal.abort(reason),
    }),
    reason,
  );
});

// Regression: missing Codex must reject rather than hang or emit an unhandled
// process error. All other checks successfully launch the external process.
test("rejects a failed app-server launch", async (t) => {
  t.mock.method(
    childProcess,
    "spawn",
    (_file: string, _args: string[], options: childProcess.SpawnOptions) =>
      spawn(process.execPath, [fixture], { ...options, cwd: fixture }),
  );
  await assert.rejects(
    renameCodexSession("persisted-probe-id", "Unused", {
      worktree: process.cwd(),
      timeoutMs: 2000,
      signal: new AbortController().signal,
    }),
    /ENOENT|ENOTDIR/u,
  );
});
