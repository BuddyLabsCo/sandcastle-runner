declare module "cross-spawn" {
  import type {
    ChildProcess,
    ChildProcessByStdio,
    SpawnOptions,
    StdioOptions,
  } from "node:child_process";
  import type { Readable, Writable } from "node:stream";

  interface CrossSpawn {
    (
      command: string,
      args: readonly string[],
      options: SpawnOptions & {
        stdio: ["pipe", "pipe", "pipe"];
      },
    ): ChildProcessByStdio<Writable, Readable, Readable>;
    (
      command: string,
      args: readonly string[],
      options: SpawnOptions & {
        stdio: ["pipe", "pipe", "ignore"];
      },
    ): ChildProcessByStdio<Writable, Readable, null>;
    (
      command: string,
      args: readonly string[],
      options: SpawnOptions & { stdio: StdioOptions },
    ): ChildProcess;
    (
      command: string,
      args: readonly string[],
      options?: SpawnOptions,
    ): ChildProcess;
  }

  const spawn: CrossSpawn;
  export default spawn;
}
