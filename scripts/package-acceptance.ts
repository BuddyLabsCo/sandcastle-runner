// Accepts the packed issue-runner tarball before publication.
//
//   RELEASE_TARBALL=/path/to/issue-runner-0.1.0.tgz npm run release:accept
//
// The publication script runs this after installing the candidate and before
// any registry write. It inspects both the dry-run and actual tarballs against
// the explicit package allowlist, then installs the same bytes through npm and
// exercises the executable shim, help, version, credential-free initialization,
// and no-fallback Project lookup from unrelated directories. Every temporary
// directory is removed; the installed package must receive no runtime writes.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { parse } from "yaml";

import { npmCommand } from "./npm-command.ts";
import { inspectPackageArtifact } from "./release/package-artifact.ts";
import { execute, withoutNpmToken } from "./release/release-lib.ts";

const packageRoot = join(import.meta.dirname, "..");
const internalPrompts = [
  "agent-attempt-input.md",
  "agent-attempt-output.md",
  "ci-repair-input.md",
  "conflict-repair-input.md",
  "implementation-review-fix.md",
  "review-attempt-input.md",
  "review-attempt-output.md",
].map((file) => `dist/prompts/${file}`);
const initializationFiles = [
  "config.yaml",
  "prompts/documentation.md",
  "prompts/implement.md",
  "prompts/review.md",
];
const initializationAssets = initializationFiles.map(
  (file) => `templates/${file}`,
);
const namedFiles = ["LICENSE", "README.md", "README.zh-CN.md", "package.json"];

function fail(message: string): never {
  throw new Error(message);
}

// The acceptance owns its installs. Drop the publication token and any
// caller-provided install policy so an outer npm script cannot change them.
function npmEnvironment(): NodeJS.ProcessEnv {
  const environment = withoutNpmToken();
  delete environment.npm_config_allow_scripts;
  return environment;
}

function runNpm(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) {
  const invocation = npmCommand(args);
  return execute(invocation.command, invocation.args, options);
}

function isAllowed(file: string): boolean {
  return (
    namedFiles.includes(file) ||
    file.startsWith("dist/") ||
    file.startsWith("templates/")
  );
}

function inspectInventory(files: string[]): void {
  const unexpected = files.filter((file) => !isAllowed(file));
  if (unexpected.length > 0) {
    fail(
      `The tarball contains files outside the allowlist: ${unexpected.join(", ")}`,
    );
  }
  const missing = [
    "dist/cli.js",
    ...internalPrompts,
    ...initializationAssets,
    ...namedFiles,
  ].filter((file) => !files.includes(file));
  if (missing.length > 0) {
    fail(`The tarball is missing required files: ${missing.join(", ")}`);
  }
  const development = files.filter(
    (file) =>
      file.endsWith(".ts") ||
      file.endsWith(".map") ||
      file.includes(".test.") ||
      /^(?:tests?|docs?|projects?|scripts|state|logs|worktrees|\.github)\//u.test(
        file,
      ),
  );
  if (development.length > 0) {
    fail(
      `The tarball contains development material: ${development.join(", ")}`,
    );
  }
  const strayRuntime = files.filter(
    (file) =>
      /(?:^|\/)(?:logs|state|worktrees|recovery|snapshots)\//u.test(file) ||
      file.endsWith(".log"),
  );
  if (strayRuntime.length > 0) {
    fail(`The tarball contains runtime data: ${strayRuntime.join(", ")}`);
  }
  const unexpectedExtension = files
    .filter((file) => file.startsWith("dist/"))
    .filter((file) => !file.endsWith(".js") && !file.endsWith(".md"));
  if (unexpectedExtension.length > 0) {
    fail(
      `The tarball dist/ contains files other than compiled modules and prompts: ${unexpectedExtension.join(", ")}`,
    );
  }
}

function inspectManifest(manifest: Record<string, unknown>): {
  version: string;
} {
  const problems: string[] = [];
  if (manifest.name !== "issue-runner")
    problems.push("name must be issue-runner");
  if (manifest.private === true) problems.push("package must not be private");
  if (typeof manifest.version !== "string" || manifest.version.length === 0)
    problems.push("version must be set");
  if (manifest.license !== "MIT") problems.push("license must be MIT");
  const bin = manifest.bin;
  const executable =
    typeof bin === "object" && bin !== null && !Array.isArray(bin)
      ? (bin as Record<string, unknown>)["issue-runner"]
      : undefined;
  if (executable !== "dist/cli.js")
    problems.push("bin.issue-runner must point at dist/cli.js");
  const engines = manifest.engines;
  const node =
    typeof engines === "object" && engines !== null && !Array.isArray(engines)
      ? (engines as Record<string, unknown>).node
      : undefined;
  if (typeof node !== "string" || node.length === 0)
    problems.push("engines.node must be set");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0)
    problems.push("files allowlist must be set");
  const repository = manifest.repository;
  const url =
    typeof repository === "object" && repository !== null
      ? (repository as Record<string, unknown>).url
      : undefined;
  if (typeof url !== "string" || !url.includes("sandcastle-runner"))
    problems.push("repository metadata must name the source repository");
  if (problems.length > 0) {
    fail(`The packaged manifest is not publishable: ${problems.join("; ")}`);
  }
  return { version: manifest.version as string };
}

function dryRunInventory(): string[] {
  const result = runNpm(["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    env: npmEnvironment(),
  });
  if (result.status !== 0) {
    fail(
      `npm pack --dry-run failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as {
    files?: { path?: unknown }[];
  }[];
  const files = (parsed[0]?.files ?? [])
    .map((entry) => entry.path)
    .filter((path): path is string => typeof path === "string");
  if (files.length === 0) fail("npm pack --dry-run reported no files");
  return files;
}

function localBin(prefix: string): string {
  return join(
    prefix,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "issue-runner.cmd" : "issue-runner",
  );
}

function globalBin(prefix: string): string {
  return process.platform === "win32"
    ? join(prefix, "issue-runner.cmd")
    : join(prefix, "bin", "issue-runner");
}

function globalPackageRoot(prefix: string): string {
  return process.platform === "win32"
    ? join(prefix, "node_modules", "issue-runner")
    : join(prefix, "lib", "node_modules", "issue-runner");
}

function runExecutable(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  if (process.platform === "win32") {
    return execute(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", executable, ...args],
      { cwd, env },
    );
  }
  return execute(executable, args, { cwd, env });
}

function tree(directory: string): string[] {
  function walk(current: string): string[] {
    return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const target = join(current, entry.name);
      if (entry.isDirectory()) return walk(target);
      const stat = statSync(target);
      return [
        `${relative(directory, target).split(sep).join("/")}:${String(stat.size)}:${String(stat.mtimeMs)}`,
      ];
    });
  }
  return walk(directory).sort();
}

function listFiles(directory: string): string[] {
  function walk(current: string): string[] {
    return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const target = join(current, entry.name);
      return entry.isDirectory()
        ? walk(target)
        : [relative(directory, target).split(sep).join("/")];
    });
  }
  return walk(directory).sort();
}

function main(): void {
  const tarball = resolve(process.env.RELEASE_TARBALL ?? "");
  if (
    process.env.RELEASE_TARBALL === undefined ||
    process.env.RELEASE_TARBALL === ""
  ) {
    fail("RELEASE_TARBALL must point at the packed issue-runner tarball");
  }
  const artifact = inspectPackageArtifact(tarball);
  const { version } = inspectManifest(artifact.manifest);
  if (!tarball.endsWith(`issue-runner-${version}.tgz`)) {
    fail(`The tarball name does not match issue-runner@${version}: ${tarball}`);
  }
  inspectInventory(artifact.files);
  const dryRun = dryRunInventory();
  inspectInventory(dryRun);
  const missingFromTarball = dryRun.filter(
    (file) => !artifact.files.includes(file),
  );
  const missingFromDryRun = artifact.files.filter(
    (file) => !dryRun.includes(file),
  );
  if (missingFromTarball.length > 0 || missingFromDryRun.length > 0) {
    fail(
      `The actual tarball and npm pack --dry-run disagree: ${[...missingFromTarball, ...missingFromDryRun].join(", ")}`,
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "issue-runner-acceptance-"));
  try {
    const prefix = join(scratch, "prefix");
    const globalPrefix = join(scratch, "global");
    const cwd = join(scratch, "launch");
    mkdirSync(cwd, { recursive: true });
    const install = (args: string[]) => runNpm(args, { env: npmEnvironment() });
    const installed = install([
      "install",
      "--prefix",
      prefix,
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      tarball,
    ]);
    if (installed.status !== 0) {
      fail(
        `The packed tarball could not be installed: ${installed.stderr.trim() || installed.stdout.trim()}`,
      );
    }
    if (!existsSync(localBin(prefix))) {
      fail(`npm did not create the issue-runner shim at ${localBin(prefix)}`);
    }
    const installedGlobally = install([
      "install",
      "--global",
      "--prefix",
      globalPrefix,
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      tarball,
    ]);
    if (installedGlobally.status !== 0) {
      fail(
        `The packed tarball could not be installed globally: ${installedGlobally.stderr.trim() || installedGlobally.stdout.trim()}`,
      );
    }
    if (!existsSync(globalBin(globalPrefix))) {
      fail(
        `npm did not create the global issue-runner shim at ${globalBin(globalPrefix)}`,
      );
    }
    const environment = npmEnvironment();
    delete environment.GH_TOKEN;
    delete environment.GITHUB_TOKEN;

    const localBefore = tree(prefix);
    const globalBefore = tree(globalPackageRoot(globalPrefix));
    const versionResult = runExecutable(
      localBin(prefix),
      ["--version"],
      cwd,
      environment,
    );
    if (versionResult.status !== 0 || versionResult.stdout.trim() !== version) {
      fail(
        `issue-runner --version reported ${versionResult.stdout.trim() || versionResult.stderr.trim()}, not ${version}`,
      );
    }
    if (listFiles(cwd).length !== 0) {
      fail("--version created files in the launch directory");
    }
    for (const args of [["--help"], ["run", "--help"]]) {
      const help = runExecutable(localBin(prefix), args, cwd, environment);
      if (help.status !== 0 || !help.stdout.includes("issue-runner")) {
        fail(`issue-runner ${args.join(" ")} failed: ${help.stderr.trim()}`);
      }
    }
    if (listFiles(cwd).length !== 0) {
      fail("help output created files in the launch directory");
    }

    const globalVersion = runExecutable(
      globalBin(globalPrefix),
      ["--version"],
      cwd,
      environment,
    );
    if (globalVersion.status !== 0 || globalVersion.stdout.trim() !== version) {
      fail(
        `the global issue-runner shim reported ${globalVersion.stdout.trim() || globalVersion.stderr.trim()}, not ${version}`,
      );
    }

    const executed = runNpm(
      [
        "exec",
        "--yes",
        "--package",
        tarball,
        "--",
        "issue-runner",
        "--version",
      ],
      {
        cwd,
        env: { ...environment, npm_config_cache: join(scratch, "cache") },
      },
    );
    if (executed.status !== 0 || !executed.stdout.includes(version)) {
      fail(
        `npm exec of the tarball failed: ${executed.stderr.trim() || executed.stdout.trim()}`,
      );
    }
    if (listFiles(cwd).length !== 0) {
      fail("npm exec created files in the launch directory");
    }

    const init = runExecutable(
      localBin(prefix),
      ["init", "--project", "demo"],
      cwd,
      environment,
    );
    if (init.status !== 0) {
      fail(
        `issue-runner init failed: ${init.stderr.trim() || init.stdout.trim()}`,
      );
    }
    if (
      JSON.stringify(listFiles(join(cwd, "demo"))) !==
      JSON.stringify(initializationFiles)
    ) {
      fail(
        "init did not create exactly the reviewed configuration and prompts",
      );
    }
    const config = parse(
      readFileSync(join(cwd, "demo", "config.yaml"), "utf8"),
    ) as { repository?: unknown };
    if (config.repository !== "your-account/your-repository") {
      fail("init did not copy the reviewed placeholder configuration");
    }
    const retained = readFileSync(join(cwd, "demo", "config.yaml"), "utf8");
    const repeat = runExecutable(
      localBin(prefix),
      ["init", "--project", "demo"],
      cwd,
      environment,
    );
    if (
      repeat.status === 0 ||
      !`${repeat.stdout}${repeat.stderr}`.includes("already exists")
    ) {
      fail("init overwrote an existing destination");
    }
    if (readFileSync(join(cwd, "demo", "config.yaml"), "utf8") !== retained) {
      fail("the rejected init changed the existing Project");
    }
    const escaped = runExecutable(
      localBin(prefix),
      ["init", "--project", "../outside"],
      cwd,
      environment,
    );
    if (
      escaped.status === 0 ||
      !`${escaped.stdout}${escaped.stderr}`.includes("Invalid project key")
    ) {
      fail("init accepted a project key outside the launch directory");
    }
    if (listFiles(cwd).length !== initializationFiles.length) {
      fail("a rejected init wrote outside its destination");
    }
    const missingProject = runExecutable(
      localBin(prefix),
      ["run", "--project", "absent", "--parent", "1"],
      cwd,
      environment,
    );
    const missingOutput = `${missingProject.stdout}\n${missingProject.stderr}`;
    if (missingProject.status === 0) {
      fail("run accepted a missing Project");
    }
    if (!missingOutput.includes(join(cwd, "absent", "config.yaml"))) {
      fail("run did not report the missing launch-directory Project path");
    }
    if (missingOutput.includes("missing credential")) {
      fail("run fell back to another Project configuration");
    }
    if (
      tree(prefix).join("\n") !== localBefore.join("\n") ||
      tree(globalPackageRoot(globalPrefix)).join("\n") !==
        globalBefore.join("\n")
    ) {
      fail("the installed package received runtime writes");
    }
    console.log(
      `Accepted issue-runner@${version}: ${String(artifact.files.length)} packaged files, executable shim, help, version, init, and no-fallback Project lookup.`,
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
