import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const engine = process.env.FAKE_ENGINE;
const mode = process.env.FAKE_MODE ?? "pass";
const workspace = value("--cwd");
const jobId = "a".repeat(32);

fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd() }));
if (mode === "timeout") {
  fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  setInterval(() => {}, 1000);
} else if (mode === "nojson") {
  process.stdout.write("no job id\n");
} else if (mode === "missing-record") {
  process.stdout.write(`${JSON.stringify(engine === "codex" ? { id: jobId } : { jobId })}\n`);
} else {
  if (args.includes("--write") && mode !== "quota" && mode !== "stderr-error") {
    fs.writeFileSync(path.join(workspace, "marker.txt"), "fake companion completed\n");
  }
  const record = {
    cwd: workspace,
    status: mode === "quota" || mode === "stderr-error" ? "error" : "done",
    failureKind: mode === "quota" || mode === "stderr-error" ? "quota" : null,
    resultText: "consult result\n",
    observedModel: "observed-model",
    resolvedEffort: "high",
    billingPool: "included",
    [`${engine}Version`]: "1.2.3",
    usage: engine === "grok" ? { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 99 } : { inputTokens: 10, outputTokens: 6, cachedInputTokens: 99 },
    totalCostUsd: 0
  };
  const jobFile = path.join(process.env[`${engine.toUpperCase()}_COMPANION_DATA`], "state", "workspace", "jobs", `${jobId}.json`);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  if (mode === "delayed-record") {
    const publisher = spawn(process.execPath, ["-e", "const fs = require('node:fs'); const path = require('node:path'); setTimeout(() => { fs.mkdirSync(path.dirname(process.argv[1]), { recursive: true }); fs.writeFileSync(process.argv[1], process.argv[2]); }, 300);", jobFile, JSON.stringify(record)], { detached: true, stdio: "ignore" });
    publisher.unref();
  } else {
    fs.writeFileSync(jobFile, JSON.stringify(record));
  }
  if (mode === "stderr-error") {
    process.stderr.write(`${JSON.stringify({ status: "error", failureKind: "quota", message: `job: ${jobId}` })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(engine === "codex" ? { id: jobId } : { jobId })}\n`);
  }
  if (mode === "quota" || mode === "stderr-error") {
    process.exitCode = 1;
  }
}
