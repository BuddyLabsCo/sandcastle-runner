import { codex } from "@ai-hero/sandcastle";

type SandcastleEffort = Exclude<
  NonNullable<Parameters<typeof codex>[1]>["effort"],
  undefined
>;

export function codexWithRunnerEffort(
  model: string,
  effort: string,
  disableWebSearch = false,
): ReturnType<typeof codex> {
  const provider = codex(model, {
    // The dependency's runtime forwards any effort string; its type is narrower.
    effort: effort as SandcastleEffort,
  });
  if (!disableWebSearch) return provider;
  return {
    ...provider,
    buildPrintCommand(input) {
      const command = provider.buildPrintCommand(input);
      return {
        ...command,
        command: `${command.command} -c 'web_search="disabled"'`,
      };
    },
  };
}
