import type { AgentProgress, OperatorIO } from "./contracts.ts";

export type ProgressPhase =
  | { kind: "implement" }
  | { kind: "fix_review"; round: number }
  | { kind: "review"; round: number }
  | { kind: "ci_repair" }
  | { kind: "conflict_repair" }
  | { kind: "maintenance" };

function phaseLabel(phase: ProgressPhase): string {
  switch (phase.kind) {
    case "implement":
      return "implement";
    case "fix_review":
      return `fix review round ${phase.round}`;
    case "review":
      return `review round ${phase.round}`;
    case "ci_repair":
      return "ci repair";
    case "conflict_repair":
      return "resolve merge conflict";
    case "maintenance":
      return "doc maintain";
  }
}

/**
 * Print one terminal line when substantive execution starts. Session probes and
 * completion are deliberately silent; a later start of the same phase is a
 * retry, including automatic Agent Retry continuations signalled by the
 * executor.
 */
export function createProgress(
  operator: OperatorIO,
  ticket: number,
  phase: ProgressPhase,
  alreadyRetried: boolean,
): AgentProgress {
  let invocations = 0;
  return {
    start() {
      invocations += 1;
      operator.write(
        `issue-${ticket}: ${phaseLabel(phase)}${
          alreadyRetried || invocations > 1 ? " retry" : ""
        }`,
      );
    },
  };
}
