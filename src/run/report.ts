import type { RunSummary, TicketReport } from "./run-input.ts";

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * OSC 8 hyperlink. Terminals without hyperlink support normally ignore the
 * escape sequence and show the short text, so `#<number>` remains readable
 * everywhere. Alignment is computed from the visible text only.
 */
function hyperlink(target: string, text: string): string {
  return `\u001b]8;;${target}\u001b\\${text}\u001b]8;;\u001b\\`;
}

function pullRequestCell(ticket: TicketReport): {
  text: string;
  target?: string;
} {
  if (ticket.pullRequest === null) return { text: "-" };
  return {
    text: `#${ticket.pullRequest}`,
    ...(ticket.pullRequestUrl === null
      ? {}
      : { target: ticket.pullRequestUrl }),
  };
}

function table(tickets: TicketReport[]): string[] {
  const rows = tickets.map((ticket) => {
    const pullRequest = pullRequestCell(ticket);
    return {
      cells: [
        String(ticket.ticket),
        ticket.status,
        pullRequest.text,
        ticket.kind === "maintenance"
          ? `Documentation: ${oneLine(ticket.detail)}`
          : oneLine(ticket.detail),
      ] as const,
      pullRequestTarget: pullRequest.target,
    };
  });
  const headings = ["Issue", "Status", "PR", "Detail"];
  const widths = headings.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => row.cells[column]!.length)),
  );
  const render = (cells: readonly string[], target?: string) =>
    cells
      .map((value, column) => {
        const padded =
          column === cells.length - 1 ? value : value.padEnd(widths[column]!);
        return column === 2 && target !== undefined
          ? hyperlink(target, padded)
          : padded;
      })
      .join("  ");
  return [
    render(headings),
    render(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => render(row.cells, row.pullRequestTarget)),
  ];
}

export function renderRunReport(summary: RunSummary): string {
  const tickets = summary.tickets ?? [];
  const lines = [
    ...(tickets.length === 0 ? ["No issues processed."] : table(tickets)),
  ];
  if (summary.failure !== undefined) {
    lines.push("", summary.failure.stack ?? summary.failure.message);
  }
  const skips = summary.skips ?? [];
  if (skips.length > 0) {
    lines.push(
      "",
      "Reasons:",
      ...skips.map(
        ({ ticket, reason }) => `- issue-${ticket}: ${oneLine(reason)}`,
      ),
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
  if (summary.outcome === "cancelled") lines.push("", "Run cancelled.");
  return lines.join("\n");
}
