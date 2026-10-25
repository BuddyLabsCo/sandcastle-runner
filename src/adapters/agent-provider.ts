import * as sandcastle from "@ai-hero/sandcastle";
import type { AgentProvider } from "@ai-hero/sandcastle";

type AgentFactory = (
  model: string,
  options?: Record<string, unknown>,
) => AgentProvider;

export function nativeAgent(
  agent: string,
  model: string,
  options?: Record<string, unknown>,
): AgentProvider {
  // Sandcastle names providers in kebab-case and exports factories in camelCase.
  const exportName = agent.replace(/-([a-z])/gu, (_, letter: string) =>
    letter.toUpperCase(),
  );
  if (!Object.hasOwn(sandcastle, exportName))
    throw new Error(`unknown Sandcastle agent ${agent}`);
  const factory = (sandcastle as Record<string, unknown>)[exportName];
  if (typeof factory !== "function")
    throw new Error(`unknown Sandcastle agent ${agent}`);
  return (factory as AgentFactory)(model, options);
}
