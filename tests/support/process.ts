import { readFile } from "node:fs/promises";

export async function waitForPid(
  filename: string,
  timeoutMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = Number((await readFile(filename, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(`process PID was not written to ${filename}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function stopProcess(pid: number): void {
  if (!processExists(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may exit between the existence check and the kill.
  }
}
