import { readdir, rm } from "node:fs/promises";
import path from "node:path";

export type AgentLogStage = "implement" | "review" | "ci" | "merge" | "doc";

export type AgentOperationPhase =
  "implement" | "ci_repair" | "conflict_repair" | "maintenance";

export interface AgentLogDeletionFailure {
  logFile?: string;
  error: string;
}

export function agentLogFile(
  projectDirectory: string,
  ticket: number,
  stage: AgentLogStage,
  attemptId: string,
): string {
  return path.join(
    projectDirectory,
    "logs",
    `${stage}-${ticket}-${attemptId}.log`,
  );
}

export function agentLogStage(phase: AgentOperationPhase): AgentLogStage {
  switch (phase) {
    case "implement":
      return "implement";
    case "ci_repair":
      return "ci";
    case "conflict_repair":
      return "merge";
    case "maintenance":
      return "doc";
  }
}

export async function deleteAgentLogs(
  projectDirectory: string,
  ticket: number,
  stage: AgentLogStage,
): Promise<AgentLogDeletionFailure[]> {
  const logsDirectory = path.join(projectDirectory, "logs");
  const prefix = `${stage}-${ticket}-`;
  let logFiles: string[];
  try {
    logFiles = (await readdir(logsDirectory))
      .filter((name) => name.startsWith(prefix) && name.endsWith(".log"))
      .map((name) => path.join(logsDirectory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [
      {
        error: error instanceof Error ? error.message : "Agent log read failed",
      },
    ];
  }

  const failures: AgentLogDeletionFailure[] = [];
  for (const logFile of logFiles) {
    try {
      await rm(logFile, { force: true });
    } catch (error) {
      failures.push({
        logFile,
        error:
          error instanceof Error ? error.message : "Agent log deletion failed",
      });
    }
  }
  return failures;
}

export async function deleteTicketAgentLogs(
  projectDirectory: string,
  ticket: number,
): Promise<AgentLogDeletionFailure[]> {
  const failures: AgentLogDeletionFailure[] = [];
  for (const stage of ["implement", "review", "ci", "merge", "doc"] as const) {
    failures.push(...(await deleteAgentLogs(projectDirectory, ticket, stage)));
  }
  return failures;
}
