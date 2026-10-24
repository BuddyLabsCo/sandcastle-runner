import { execFile, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const terminationTimeoutMs = 5_000;
const terminationPollMs = 25;

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  if (process.platform !== "win32") {
    const descendants = await descendantProcesses(child.pid);
    for (const pid of descendants.reverse()) killIfRunning(pid);
    child.kill("SIGKILL");
    await waitForProcessesExit([child.pid, ...descendants]);
    return;
  }

  const windowsDirectory = process.env.SystemRoot ?? process.env.windir;
  const taskkill = windowsDirectory
    ? join(windowsDirectory, "System32", "taskkill.exe")
    : "taskkill";
  await execFileAsync(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
    killSignal: "SIGKILL",
    timeout: terminationTimeoutMs,
    windowsHide: true,
  }).catch((error: unknown) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    throw error;
  });
}

async function descendantProcesses(rootPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid="], {
    timeout: terminationTimeoutMs,
  });
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/u);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
    const entries = children.get(parent) ?? [];
    entries.push(pid);
    children.set(parent, entries);
  }
  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift()!;
    descendants.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

function killIfRunning(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessesExit(pids: number[]): Promise<void> {
  const deadline = Date.now() + terminationTimeoutMs;
  for (;;) {
    if (pids.every((pid) => !processRunning(pid))) return;
    if (Date.now() >= deadline)
      throw new Error("process tree did not exit after termination");
    await new Promise((resolve) => setTimeout(resolve, terminationPollMs));
  }
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
