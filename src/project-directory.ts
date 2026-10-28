import path from "node:path";

// `--project` is a key for one child of the launch directory, never a path.
const projectKeyPattern = /^[A-Za-z0-9._-]+$/u;

export function resolveProjectDirectory(
  launchDirectory: string,
  projectKey: string,
): string {
  if (
    !projectKeyPattern.test(projectKey) ||
    projectKey === "." ||
    projectKey === ".."
  ) {
    throw new Error(
      `Invalid project key "${projectKey}"; use letters, digits, dot, underscore, or hyphen for a child of the launch directory`,
    );
  }
  const launch = path.resolve(launchDirectory);
  const directory = path.resolve(launch, projectKey);
  if (path.dirname(directory) !== launch) {
    throw new Error(
      `Invalid project key "${projectKey}"; it must resolve beneath ${launch}`,
    );
  }
  return directory;
}
