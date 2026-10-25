import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { codex } from "@ai-hero/sandcastle";

type SandcastleEffort = Exclude<
  NonNullable<Parameters<typeof codex>[1]>["effort"],
  undefined
>;

export function codexWithRunnerEffort(
  model: string,
  effort: string,
): ReturnType<typeof codex> {
  const configuredHome = process.env.CODEX_HOME?.trim();
  return codex(model, {
    // The dependency's runtime forwards any effort string; its type is narrower.
    effort: effort as SandcastleEffort,
    sessionStorage: {
      hostSessionsDir: join(
        configuredHome ? resolve(configuredHome) : join(homedir(), ".codex"),
        "sessions",
      ),
    },
  });
}
