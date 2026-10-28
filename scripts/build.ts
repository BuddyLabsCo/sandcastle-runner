// Emits the published JavaScript from src/ and copies the Markdown prompts the
// compiled adapter loads. The package ships dist/, so the build must run before
// packing; prepack wires that automatically.
import { spawnSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

await rm(join(root, "dist"), { force: true, recursive: true });
const compiled = spawnSync(
  process.execPath,
  [tsc, "--project", join(root, "tsconfig.build.json")],
  { cwd: root, stdio: "inherit" },
);
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
await cp(join(root, "src", "prompts"), join(root, "dist", "prompts"), {
  recursive: true,
});
