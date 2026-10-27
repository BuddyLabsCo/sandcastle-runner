import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadProject } from "../../src/config.ts";

const root = path.resolve(import.meta.dirname, "../..");

const placeholders = {
  "implement.md": [],
  "review.md": [],
  "documentation.md": [],
} as const;

test("checked-in projects are loadable and have exact prompt placeholders", async () => {
  const projects = await readdir(path.join(root, "projects"), {
    withFileTypes: true,
  });
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const directory = path.join(root, "projects", project.name);
    await loadProject(root, project.name, { GH_TOKEN: "test-only" });
    for (const [filename, expected] of Object.entries(placeholders)) {
      const prompt = await readFile(
        path.join(directory, "prompts", filename),
        "utf8",
      );
      const actual = [
        ...new Set(
          [...prompt.matchAll(/\{\{([A-Z_]+)\}\}/gu)].map((match) => match[1]),
        ),
      ].sort();
      assert.deepEqual(actual, expected, filename);
      assert.doesNotMatch(
        prompt,
        /<([A-Za-z0-9_]+)>/u,
        `${filename} output tag`,
      );
    }
  }
});

test("Runner-owned output protocols use the configured tags and fields", async () => {
  const protocols = {
    "agent-attempt-output.md": {
      tag: "agent_attempt_result",
      fields: ["outcome", "summary", "commits", "checks", "blocker"],
    },
    "review-attempt-output.md": {
      tag: "review_attempt_result",
      fields: ["outcome", "findings_file", "blocker"],
    },
  } as const;
  for (const [filename, expected] of Object.entries(protocols)) {
    const prompt = await readFile(
      path.join(root, "src", "prompts", filename),
      "utf8",
    );
    const tags = [...prompt.matchAll(/<([A-Za-z0-9_]+)>/gu)].map(
      (match) => match[1],
    );
    assert.deepEqual(tags, [expected.tag], `${filename} output tag`);
    for (const field of expected.fields)
      assert.match(
        prompt,
        new RegExp(`"${field}"`, "u"),
        `${filename} ${field}`,
      );
  }
});
