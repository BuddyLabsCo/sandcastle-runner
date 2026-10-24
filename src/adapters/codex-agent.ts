import { codex } from "@ai-hero/sandcastle";

type SandcastleEffort = Exclude<
  NonNullable<Parameters<typeof codex>[1]>["effort"],
  undefined
>;

export function codexWithRunnerEffort(
  model: string,
  effort: string,
): ReturnType<typeof codex> {
  return codex(model, {
    // The dependency's runtime forwards any effort string; its type is narrower.
    effort: effort as SandcastleEffort,
  });
}
