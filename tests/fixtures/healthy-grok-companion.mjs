import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv.slice(2).join(" ") === "host-check --json") {
  process.stdout.write(JSON.stringify({ blockers: [] }));
} else {
  const companion = fileURLToPath(new URL("../../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [companion, ...process.argv.slice(2)], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
