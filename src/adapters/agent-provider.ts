import { claudeCode, codex, pi, type AgentProvider } from "@ai-hero/sandcastle";

export function nativeAgent(
  agent: string,
  model: string,
  options?: Record<string, unknown>,
): AgentProvider {
  if (agent === "codex") return codex(model, options);
  if (agent === "claude-code") return claudeCode(model, options);
  if (agent === "pi") return pi(model, options);
  throw new Error(`unknown Sandcastle agent ${agent}`);
}
