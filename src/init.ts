import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { resolveProjectDirectory } from "./project-directory.ts";

const initializationFiles = [
  "config.yaml",
  "prompts/implement.md",
  "prompts/review.md",
  "prompts/documentation.md",
] as const;

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function initializeProject(
  launchDirectory: string,
  projectKey: string,
): Promise<string> {
  const directory = resolveProjectDirectory(launchDirectory, projectKey);
  try {
    // A non-recursive mkdir is the atomic existence check: it also refuses an
    // empty directory, a file, a symbolic link, and a destination created by a
    // concurrent Run instead of adopting any of them.
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Cannot initialize Project at ${directory}: the destination already exists`,
        { cause: error },
      );
    }
    throw new Error(
      `Initialization failed for ${directory}: ${failureMessage(error)}`,
      { cause: error },
    );
  }
  const assets = path.join(import.meta.dirname, "..", "templates");
  try {
    await mkdir(path.join(directory, "prompts"));
    for (const file of initializationFiles) {
      await copyFile(
        path.join(assets, file),
        path.join(directory, file),
        constants.COPYFILE_EXCL,
      );
    }
  } catch (error) {
    // Keep the files already written so the operator can inspect the failure.
    throw new Error(
      `Initialization failed for ${directory}: ${failureMessage(error)}; partial output was retained for inspection`,
      { cause: error },
    );
  }
  return directory;
}
