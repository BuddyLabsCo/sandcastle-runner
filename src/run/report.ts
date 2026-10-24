import type { RunSummary, TicketReport } from "./run-input.ts";

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function table(tickets: TicketReport[]): string[] {
  const rows = tickets.map((ticket) => [
    String(ticket.ticket),
    ticket.status,
    ticket.pullRequest === null ? "-" : `#${ticket.pullRequest}`,
    ticket.kind === "maintenance"
      ? `Documentation: ${oneLine(ticket.detail)}`
      : oneLine(ticket.detail),
  ]);
  const widths = ["Issue", "Status", "PR", "Detail"].map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => row[column]!.length)),
  );
  const render = (row: string[]) =>
    row
      .map((value, column) =>
        column === row.length - 1 ? value : value.padEnd(widths[column]!),
      )
      .join("  ");
  return [
    render(["Issue", "Status", "PR", "Detail"]),
    render(widths.map((width) => "-".repeat(width))),
    ...rows.map(render),
  ];
}

export function renderRunReport(
  summary: RunSummary,
  auditPath: string,
): string {
  const tickets = summary.tickets ?? [];
  const lines = [
    ...(tickets.length === 0 ? ["No issues processed."] : table(tickets)),
  ];
  if (summary.reasons.length > 0) {
    lines.push(
      "",
      "Reasons:",
      ...summary.reasons.map((reason) => `- ${oneLine(reason)}`),
    );
  }
  const worktrees = [
    ...new Set(tickets.flatMap((ticket) => ticket.retainedWorktrees)),
  ];
  if (worktrees.length > 0) {
    lines.push(
      "",
      "Retained Worktrees:",
      ...worktrees.map((path) => `- ${path}`),
    );
  }
  lines.push("", `Audit Log: ${auditPath}`);
  return lines.join("\n");
}
