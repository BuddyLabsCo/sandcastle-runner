import type { AgentProvider } from "@ai-hero/sandcastle";

import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type AgentSessionStorage = NonNullable<AgentProvider["sessionStorage"]>;
type ParsedStreamEvent = ReturnType<AgentProvider["parseStreamLine"]>[number];

const quote = (value: string): string =>
  "'" + value.replace(/'/gu, "'\\''") + "'";

function validateSessionId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/u.test(id))
    throw new Error("invalid CodeBuddy session ID");
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function streamParser(resumeSession?: string) {
  let sessionId = resumeSession;
  let finalSeen = false;
  let initialized = false;
  let failure: string | undefined;
  const fail = (evidence: unknown): ParsedStreamEvent[] => {
    // Diagnostics must not expose embedded result tags to Sandcastle's extractor.
    failure ??= `CodeBuddy protocol failure: ${JSON.stringify({ sessionId, evidence }).replace(/</gu, "\\u003c")}`;
    return [
      { type: "result", result: failure },
      // Keep retry context, but never let a failed new-session probe supply an ID.
      { type: "session_id", sessionId: resumeSession ?? "" },
    ];
  };
  return (line: string): ParsedStreamEvent[] => {
    let event: Record<string, unknown>;
    try {
      event = object(JSON.parse(line));
    } catch {
      return finalSeen
        ? []
        : [
            {
              type: "result",
              result: failure ?? "CodeBuddy missing final result",
            },
          ];
    }
    if (event.type === "system" && event.subtype === "init") {
      const id = event.session_id;
      if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/u.test(id))
        return fail(event);
      if (sessionId !== undefined && sessionId !== id) return fail(event);
      initialized = true;
      sessionId = id;
      return [
        ...(resumeSession === undefined
          ? []
          : [{ type: "session_id" as const, sessionId: id }]),
        { type: "result", result: failure ?? "CodeBuddy missing final result" },
      ];
    }
    if (event.type === "error") return fail(event);
    if (event.type === "result") {
      if (failure !== undefined) return fail(event);
      if (
        !initialized ||
        finalSeen ||
        (event.is_error !== undefined && event.is_error !== false) ||
        event.subtype !== "success" ||
        event.terminal_reason !== undefined ||
        typeof event.result !== "string" ||
        event.result.trim() === "" ||
        sessionId === undefined ||
        (event.session_id !== undefined && event.session_id !== sessionId)
      )
        return fail(event);
      finalSeen = true;
      return [
        { type: "session_id", sessionId },
        { type: "result", result: event.result },
      ];
    }
    const content = object(event.message).content;
    if (
      (event.type !== "assistant" && event.type !== "user") ||
      !Array.isArray(content)
    )
      return finalSeen
        ? []
        : [
            {
              type: "result",
              result: failure ?? "CodeBuddy missing final result",
            },
          ];
    const events: ParsedStreamEvent[] = [];
    for (const value of content) {
      const block = object(value);
      if (
        event.type === "assistant" &&
        block.type === "text" &&
        typeof block.text === "string"
      )
        events.push({ type: "text", text: block.text });
      if (
        event.type === "assistant" &&
        block.type === "tool_use" &&
        typeof block.name === "string"
      )
        events.push({
          type: "tool_call",
          name: block.name,
          args: JSON.stringify(block.input ?? {}),
        });
      if (
        event.type === "user" &&
        block.type === "tool_result" &&
        block.is_error === true
      )
        events.push({
          type: "text",
          text: `CodeBuddy tool error: ${JSON.stringify(block)}`,
        });
    }
    return events;
  };
}

function nativeOptions(options: Record<string, unknown>) {
  const flags: string[] = [];
  const scalar: Record<string, string> = {
    effort: "--effort",
    maxTurns: "--max-turns",
    permissionMode: "--permission-mode",
    systemPrompt: "--system-prompt",
    appendSystemPrompt: "--append-system-prompt",
  };
  for (const [key, value] of Object.entries(options)) {
    if (key === "env") continue;
    if (key === "allowedTools" || key === "disallowedTools") {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((v: unknown) => typeof v !== "string" || v.trim() === "")
      )
        throw new Error(`CodeBuddy ${key} must be a nonempty string array`);
      flags.push(`--${key} ${(value as string[]).map(quote).join(" ")}`);
    } else if (key === "tools" && typeof value === "string") {
      // Keep empty tools as --tools=, since the host launcher drops empty argv tokens.
      flags.push(`--tools=${quote(value)}`);
    } else if (
      key === "maxTurns" &&
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0
    ) {
      flags.push(`${scalar[key]} ${quote(String(value))}`);
    } else if (
      Object.hasOwn(scalar, key) &&
      key !== "maxTurns" &&
      typeof value === "string" &&
      value.trim() !== ""
    ) {
      if (
        key === "effort" &&
        !["minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
      )
        throw new Error("invalid CodeBuddy effort");
      if (
        key === "permissionMode" &&
        ![
          "acceptEdits",
          "bypassPermissions",
          "default",
          "plan",
          "dontAsk",
          "auto",
        ].includes(value)
      )
        throw new Error("invalid CodeBuddy permissionMode");
      flags.push(`${scalar[key]} ${quote(value)}`);
    } else throw new Error(`unsupported or invalid CodeBuddy option ${key}`);
  }
  if (options.permissionMode === undefined)
    flags.push("--permission-mode 'bypassPermissions'");
  const env: Record<string, string> = {};
  if (options.env !== undefined) {
    if (
      typeof options.env !== "object" ||
      options.env === null ||
      Array.isArray(options.env)
    )
      throw new Error("CodeBuddy env must be a string map");
    for (const [key, value] of Object.entries(options.env)) {
      if (typeof value !== "string")
        throw new Error(`CodeBuddy env.${key} must be a string`);
      env[key] = value;
    }
  }
  const store = env.CODEBUDDY_CONFIG_DIR ?? process.env.CODEBUDDY_CONFIG_DIR;
  if (store?.trim() && !isAbsolute(store))
    throw new Error("CodeBuddy CODEBUDDY_CONFIG_DIR must be absolute");
  env.CODEBUDDY_IS_SANDBOX ??= process.env.CODEBUDDY_IS_SANDBOX ?? "1";
  env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS = "1";
  return { flags: flags.join(" "), env };
}

function sessionStorage(env: Record<string, string>): AgentSessionStorage {
  const configured =
    env.CODEBUDDY_CONFIG_DIR ?? process.env.CODEBUDDY_CONFIG_DIR;
  const childHome =
    env[process.platform === "win32" ? "USERPROFILE" : "HOME"] ?? homedir();
  if (!configured?.trim() && !isAbsolute(childHome))
    throw new Error(
      "CodeBuddy effective home must be absolute for session lookup",
    );
  const root = join(
    resolve(configured?.trim() ? configured : join(childHome, ".codebuddy")),
    "projects",
  );
  const findByIdOnHost: AgentSessionStorage["findByIdOnHost"] = async (id) => {
    validateSessionId(id);
    const matches: string[] = [];
    let projects;
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (!missing(error)) throw error;
      return { path: undefined, searchedRoot: root };
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const candidate = join(root, project.name, `${id}.jsonl`);
      try {
        if ((await lstat(candidate)).isFile()) matches.push(candidate);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    if (matches.length > 1)
      throw new Error(`ambiguous CodeBuddy session ${id} in ${root}`);
    return { path: matches[0], searchedRoot: root };
  };
  const unsupported = (): Promise<never> =>
    Promise.reject(
      new Error("CodeBuddy sandbox session transfer is unsupported"),
    );
  return {
    findByIdOnHost,
    captureToHost: unsupported,
    resumeIntoSandbox: unsupported,
    hostSessionFilePath: () => undefined,
    async readHostSession(_cwd, id) {
      const found = await findByIdOnHost(id);
      return found.path === undefined
        ? undefined
        : readFile(found.path, "utf8");
    },
    async existsOnHost(_cwd, id) {
      return (await findByIdOnHost(id)).path !== undefined;
    },
  };
}

export function codebuddy(
  model: string,
  options: Record<string, unknown> = {},
): AgentProvider {
  const { env, flags } = nativeOptions(options);
  let parse = streamParser();
  return {
    name: "codebuddy",
    env,
    captureSessions: false,
    sessionStorage: sessionStorage(env),
    buildPrintCommand({ prompt, resumeSession, forkSession }) {
      if (forkSession)
        throw new Error("CodeBuddy session forks are unsupported");
      if (resumeSession !== undefined) validateSessionId(resumeSession);
      parse = streamParser(resumeSession);
      return {
        command: `codebuddy --print --verbose --output-format stream-json --model ${quote(model)} ${flags}${resumeSession ? ` --resume ${quote(resumeSession)}` : ""}`,
        stdin: prompt,
      };
    },
    parseStreamLine: (line) => parse(line),
  };
}
