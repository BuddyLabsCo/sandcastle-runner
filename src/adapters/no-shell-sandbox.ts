import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { createInterface } from "node:readline";

import type {
  NoSandboxProvider,
  SandboxExecOptions,
  InteractiveExecOptions,
} from "@ai-hero/sandcastle";
import crossSpawn from "cross-spawn";

import { formatToolError } from "./process-errors.ts";
import { terminateProcessTree } from "./process-tree.ts";

function commandArgs(command: string): [string, ...string[]] {
  const trimmed = command.trim();
  const args: string[] = [];
  let value = "";
  let quote = "";
  let escaped = false;
  let windowsPath = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (escaped) {
      value += character;
      escaped = false;
    } else if (
      quote === '"' &&
      value === "" &&
      character === "\\" &&
      trimmed[index + 1] === "\\"
    ) {
      windowsPath = true;
      value += character;
    } else if (character === "\\" && quote !== "'") {
      if (windowsPath) {
        value += "\\";
      } else {
        escaped = true;
      }
    } else if (quote !== "" && character === quote) {
      quote = "";
      windowsPath = false;
    } else if (quote === "") {
      if (character === "'" || character === '"') quote = character;
      else if (/\s/u.test(character)) {
        if (value !== "") {
          args.push(value);
          value = "";
          windowsPath = false;
        }
      } else {
        value += character;
      }
    } else {
      value += character;
      windowsPath ||= quote === '"' && /^[A-Za-z]:$/.test(value);
    }
  }
  if (escaped) throw new Error("invalid host command quoting");
  if (quote !== "") throw new Error("invalid host command quoting");
  if (value !== "") args.push(value);
  if (args.length === 0) throw new Error("empty host command");
  return args as [string, ...string[]];
}

interface OwnedProcess {
  child: ChildProcess;
  done: Promise<void>;
}

export type ProcessSettlement =
  { outcome: "settled" } | { outcome: "failed"; error: string };

export interface NoShellSandboxProvider extends NoSandboxProvider {
  settle(): Promise<ProcessSettlement>;
}

function pipedChild(child: ChildProcess): ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr)
    throw new Error("no-sandbox child process does not expose piped stdio");
  return child as ChildProcessWithoutNullStreams;
}

function startProcess(
  file: string,
  args: string[],
  options: SpawnOptions,
  owned: Set<OwnedProcess>,
): { child: ChildProcess; done: Promise<void> } {
  const child = crossSpawn(file, args, options);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ownedProcess: OwnedProcess = { child, done };
  owned.add(ownedProcess);
  const settle = () => {
    owned.delete(ownedProcess);
    finish();
  };
  child.once("close", settle);
  child.once("error", settle);
  return ownedProcess;
}

async function stopProcess(ownedProcess: OwnedProcess): Promise<void> {
  const { child, done } = ownedProcess;
  await terminateProcessTree(child);
  await done;
}

async function stopOwnedProcesses(processes: OwnedProcess[]): Promise<void> {
  const results = await Promise.allSettled(processes.map(stopProcess));
  const failures: unknown[] = [];
  for (const result of results)
    if (result.status === "rejected") failures.push(result.reason);
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `failed to settle ${failures.length} owned process(es): ${failures
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join("; ")}`,
    );
}

export function noShellSandbox(
  options: {
    env?: Record<string, string>;
  } = {},
): NoShellSandboxProvider {
  const closeHandles = new Set<() => Promise<void>>();
  return {
    tag: "none",
    name: "no-sandbox",
    env: options.env ?? {},
    create: ({
      worktreePath,
      env,
    }: {
      worktreePath: string;
      env: Record<string, string>;
    }) => {
      const processEnv = { ...process.env, ...env };
      const owned = new Set<OwnedProcess>();
      let closing: Promise<void> | undefined;
      const close = () => {
        closing ??= stopOwnedProcesses([...owned]);
        return closing;
      };
      closeHandles.add(close);
      return Promise.resolve({
        worktreePath,
        exec: (command: string, execOptions: SandboxExecOptions = {}) => {
          const [file, ...args] = commandArgs(command);
          const child = pipedChild(
            startProcess(
              file,
              args,
              {
                cwd: execOptions.cwd ?? worktreePath,
                env: processEnv,
                shell: false,
                stdio: ["pipe", "pipe", "pipe"],
              },
              owned,
            ).child,
          );
          if (execOptions.stdin !== undefined) {
            child.stdin.write(execOptions.stdin);
          }
          child.stdin.end();
          return new Promise((resolve, reject) => {
            let stdout = "";
            let stderr = "";
            const readline = execOptions.onLine
              ? createInterface({ input: child.stdout })
              : undefined;
            if (execOptions.onLine) readline?.on("line", execOptions.onLine);
            child.stdout.on("data", (chunk: Buffer) => {
              stdout += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            child.once("error", (error) => {
              reject(new Error(formatToolError(file, error)));
            });
            child.once("close", (exitCode) => {
              readline?.close();
              resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
            });
          });
        },
        interactiveExec: async (
          args: string[],
          execOptions: InteractiveExecOptions,
        ) =>
          new Promise((resolve, reject) => {
            const [file, ...commandArgsForSpawn] = args;
            const { child } = startProcess(
              file!,
              commandArgsForSpawn,
              {
                cwd: execOptions.cwd ?? worktreePath,
                env: processEnv,
                shell: false,
                stdio: [
                  execOptions.stdin as never,
                  execOptions.stdout as never,
                  execOptions.stderr as never,
                ],
              },
              owned,
            );
            child.once("error", (error) =>
              reject(new Error(formatToolError(args[0]!, error))),
            );
            child.once("close", (exitCode) =>
              resolve({ exitCode: exitCode ?? 0 }),
            );
          }),
        close,
      });
    },
    settle: async () => {
      const results = await Promise.allSettled(
        [...closeHandles].map((close) => close()),
      );
      const failures: unknown[] = [];
      for (const result of results)
        if (result.status === "rejected") failures.push(result.reason);
      return failures.length === 0
        ? { outcome: "settled" }
        : {
            outcome: "failed",
            error: failures
              .map((error) =>
                error instanceof Error ? error.message : String(error),
              )
              .join("; "),
          };
    },
  } as NoShellSandboxProvider;
}
