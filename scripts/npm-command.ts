import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface NpmCommand {
  command: string;
  args: string[];
}

const npmCliPattern = /[/\\]npm-cli\.(?:cjs|js)$/u;

// npm is a `.cmd` shim on Windows, which Node cannot spawn directly. Launch
// npm's JavaScript entry point with the running Node executable instead, so
// package checks use one portable command boundary on every platform.
export function npmCommand(args: string[]): NpmCommand {
  const bundledRoot =
    process.platform === "win32"
      ? dirname(process.execPath)
      : join(dirname(process.execPath), "..", "lib");
  const candidates = [
    process.env.npm_execpath,
    join(bundledRoot, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const cli = candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined &&
      npmCliPattern.test(candidate) &&
      existsSync(candidate),
  );
  if (cli === undefined) {
    throw new Error(
      "Could not locate npm's JavaScript entry point; run this command through npm",
    );
  }
  return { command: process.execPath, args: [cli, ...args] };
}
