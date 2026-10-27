import type { OperatorIO } from "./contracts.ts";

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
 * retry.
 */
export function showProgress(
  operator: OperatorIO,
  ticket: number,
  phase: ProgressPhase,
  retry: boolean,
): void {
  operator.write(
    `issue-${ticket}: ${phaseLabel(phase)}${retry ? " retry" : ""}`,
  );
}
