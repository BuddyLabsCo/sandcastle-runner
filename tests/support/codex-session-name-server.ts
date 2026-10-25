import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const lines = createInterface({ input: process.stdin });
const methods: string[] = [];
const scenario = process.argv[2];
if (process.env.SANDBOX_TEST_PID_FILE)
  writeFileSync(process.env.SANDBOX_TEST_PID_FILE, String(process.pid));
lines.on("line", (line) => {
  const message = JSON.parse(line) as {
    id?: number;
    method: string;
    params?: { threadId?: string; name?: string };
  };
  methods.push(message.method);
  if (message.method === "initialize") {
    if (scenario === "initialize-timeout") return;
    if (scenario === "initialize-error") {
      process.stdout.write(
        `${JSON.stringify({ id: message.id, error: { code: -32600, message: "Initialization rejected" } })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { userAgent: "codex-test" } })}\n`,
    );
  } else if (message.method === "thread/name/set") {
    if (
      methods.join(",") !== "initialize,initialized,thread/name/set" ||
      message.params?.threadId !== "persisted-probe-id" ||
      message.params.name !== 'Issue #169: "renamed"\n\u4f1a\u8bdd'
    ) {
      process.stdout.write(
        `${JSON.stringify({ id: message.id, error: { code: -32602, message: "Unexpected naming protocol" } })}\n`,
      );
      return;
    }
    if (scenario === "exit") process.exit(7);
    if (scenario === "malformed-json") {
      process.stdout.write("not-json\n");
      return;
    }
    if (scenario === "rename-error") {
      process.stdout.write(
        `${JSON.stringify({ id: message.id, error: { code: -32602, message: "Unknown thread" } })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${JSON.stringify({ method: "thread/name/updated", params: message.params })}\n`,
    );
    process.stdout.write(`${JSON.stringify({ id: 99, result: {} })}\n`);
    if (scenario === "no-ack") return;
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: scenario === "invalid-ack" ? [] : {} })}\n`,
    );
  }
});
