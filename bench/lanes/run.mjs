#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertEnvironmentPins, assertManifestPins, cliVersion, collectPluginVersions, killSpawnGroup, readJsonFile, runBounded } from "../lib.mjs";
import { buildManifest } from "../manifest.mjs";
import { newestEngineCompanion } from "../../plugins/fusion/scripts/lib/engine-acceptance.mjs";
import { readEngineJobRecord, resolveEngineStateRoots } from "../../plugins/fusion/scripts/lib/engine-job-state.mjs";

const DEFAULT_TASK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tasks");
const CURSOR_PLUGIN_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "cursor", ".claude-plugin", "plugin.json");
const ENGINES = new Set(["codex", "grok", "cursor"]);
const MODES = new Set(["write", "consult"]);
const OPTIONS = new Set(["task", "engine", "mode", "repetition", "results", "model", "effort", "brief", "fixtures", "task-root", "timeout-ms", "verify-timeout-ms"]);
const USAGE = "Usage: node bench/lanes/run.mjs --task <task-id> --engine <codex|grok|cursor> --mode <write|consult> --repetition <n> --results <dir> [--model <id>] [--effort <level>] [--brief <file>] [--fixtures <dir inside the task>] [--task-root <dir>] [--timeout-ms <n>] [--verify-timeout-ms <n>] (env: BENCH_VERIFY_TIMEOUT_MS; default: 600000 ms)";

function parseArgs(argv) {
  const raw = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || !OPTIONS.has(option.slice(2)) || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid or incomplete option: ${option ?? "<missing>"}`);
    }
    if (Object.hasOwn(raw, option.slice(2))) {
      throw new Error(`Duplicate option: ${option}`);
    }
    raw[option.slice(2)] = value;
  }
  for (const key of ["task", "engine", "mode", "repetition", "results"]) {
    if (!raw[key]) {
      throw new Error(`Missing required option --${key}`);
    }
  }
  if (!ENGINES.has(raw.engine) || !MODES.has(raw.mode)) {
    throw new Error("Unknown engine or mode");
  }
  if (!/^[1-9]\d*$/.test(raw.repetition) || !Number.isSafeInteger(Number(raw.repetition))) {
    throw new Error("Repetition must be a positive integer");
  }
  for (const [key, value] of [["timeout-ms", raw["timeout-ms"]], ["verify-timeout-ms", raw["verify-timeout-ms"] ?? process.env.BENCH_VERIFY_TIMEOUT_MS]]) {
    if (value !== undefined && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647)) {
      throw new Error(`${key} must be a positive integer`);
    }
  }
  if (raw.mode === "consult" && !raw.brief) {
    throw new Error("--brief is required in consult mode");
  }
  for (const key of ["model", "effort", "brief", "fixtures", "task-root"]) {
    if (raw[key] === "") {
      throw new Error(`Empty value for --${key}`);
    }
  }
  return {
    taskId: raw.task,
    engine: raw.engine,
    mode: raw.mode,
    repetition: Number(raw.repetition),
    resultsDir: path.resolve(raw.results),
    model: raw.model ?? null,
    effort: raw.effort ?? null,
    brief: raw.brief ? path.resolve(raw.brief) : null,
    fixtures: raw.fixtures ?? "fixtures",
    taskRoot: path.resolve(raw["task-root"] ?? DEFAULT_TASK_ROOT),
    timeoutMs: Number(raw["timeout-ms"] ?? 900000),
    verifyTimeoutMs: Number(raw["verify-timeout-ms"] ?? process.env.BENCH_VERIFY_TIMEOUT_MS ?? 600000)
  };
}

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function taskFiles(options) {
  const taskDir = path.resolve(options.taskRoot, options.taskId);
  const fixturesDir = path.resolve(taskDir, options.fixtures);
  if (!inside(options.taskRoot, taskDir) || !inside(taskDir, fixturesDir)) {
    throw new Error("Task or fixtures path escapes its root");
  }
  const briefFile = options.brief ?? path.join(taskDir, "brief.md");
  const verifyFile = path.join(taskDir, "verify.sh");
  if (!fs.statSync(taskDir).isDirectory() || !fs.statSync(fixturesDir).isDirectory() || !fs.statSync(briefFile).isFile() || (options.mode === "write" && !fs.statSync(verifyFile).isFile())) {
    throw new Error("Task files are missing");
  }
  if (!inside(fs.realpathSync(taskDir), fs.realpathSync(fixturesDir))) {
    throw new Error("Fixtures path escapes task through a symlink");
  }
  return { fixturesDir, briefText: fs.readFileSync(briefFile, "utf8"), verifyFile };
}

function git(workspace, args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024, detached: true });
  killSpawnGroup(result.pid);
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  }
  return result.stdout;
}

function prepareWorkspace(fixturesDir) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-bench-lane-")));
  const workspace = path.join(tempRoot, "work");
  try {
    fs.cpSync(fixturesDir, workspace, { recursive: true });
    git(workspace, ["init", "-q"]);
    git(workspace, ["config", "user.name", "Fusion Bench"]);
    git(workspace, ["config", "user.email", "fusion-bench@localhost"]);
    git(workspace, ["add", "-A"]);
    git(workspace, ["commit", "-q", "--allow-empty", "-m", "benchmark fixture"]);
    return { tempRoot, workspace };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function runCompanion(companion, args, workspace, timeoutMs) {
  try {
    const result = await runBounded(process.execPath, [companion, ...args], { cwd: workspace, env: process.env, timeoutMs, label: "Companion" });
    return { stdout: result.stdout, stderr: result.stderr, seconds: result.seconds, exit: result.timedOut ? null : result.signal ? null : result.exitCode, failure: result.timedOut ? { type: "timeout", message: `Companion timed out after ${timeoutMs} ms` } : null };
  } catch (error) {
    return { stdout: "", exit: null, seconds: 0, failure: { type: "start", message: error.message } };
  }
}

async function waitForJob(engine, jobId) {
  const deadline = Date.now() + 5000;
  do {
    const job = readEngineJobRecord(engine, jobId, process.env);
    if (job) return job;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  } while (true);
}

function jobIdFromStdout(stdout, engine) {
  try {
    const payload = JSON.parse(stdout);
    const id = engine === "codex" ? payload?.id : payload?.jobId;
    return typeof id === "string" && /^[0-9a-f]{32}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function failedJobIdFromState(engine, workspace) {
  for (const root of resolveEngineStateRoots(engine, process.env)) {
    let workspaces;
    try {
      workspaces = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of workspaces) {
      if (!entry.isDirectory()) {
        continue;
      }
      let jobs;
      try {
        jobs = fs.readdirSync(path.join(root, entry.name, "jobs"));
      } catch {
        continue;
      }
      for (const filename of jobs) {
        const id = filename.endsWith(".json") ? filename.slice(0, -5) : "";
        if (!/^[0-9a-f]{32}$/.test(id)) {
          continue;
        }
        try {
          const record = JSON.parse(fs.readFileSync(path.join(root, entry.name, "jobs", filename), "utf8"));
          if (record?.cwd === workspace) {
            return id;
          }
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

function writeEnvOnce(resultsDir, taskManifestHash) {
  const envFile = path.join(resultsDir, "env.json");
  const env = {
    date: new Date().toISOString(),
    nodeVersion: process.version,
    os: { platform: os.platform(), release: os.release() },
    pluginVersions: { ...collectPluginVersions(process.env), cursor: readJsonFile(CURSOR_PLUGIN_FILE)?.version ?? null },
    engineCliVersions: { codex: cliVersion("codex"), grok: cliVersion("grok"), cursor: cliVersion("cursor-agent") },
    taskManifestHash,
    manifestHash: taskManifestHash
  };
  if (fs.existsSync(envFile)) {
    const existing = JSON.parse(fs.readFileSync(envFile, "utf8"));
    assertManifestPins(existing, [], resultsDir);
    if (existing.manifestHash !== taskManifestHash) {
      throw new Error(`${envFile}: conflicting manifest pins: existing=${JSON.stringify(existing.manifestHash)} vs current=${JSON.stringify(taskManifestHash)}`);
    }
    assertEnvironmentPins(existing, env, resultsDir);
    return;
  }
  try {
    fs.writeFileSync(envFile, `${JSON.stringify(env, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

async function attempt(options) {
  const { fixturesDir, briefText, verifyFile } = taskFiles(options);
  const taskManifestHash = buildManifest(options.taskRoot).manifestHash;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const { tempRoot, workspace } = prepareWorkspace(fixturesDir);
  try {
    fs.mkdirSync(options.resultsDir, { recursive: true });
    writeEnvOnce(options.resultsDir, taskManifestHash);
    const companionPath = newestEngineCompanion(options.engine, process.env);
    const args = ["task", ...(options.mode === "write" ? ["--write"] : []), "--json", ...(options.model ? ["--model", options.model] : []), ...(options.effort ? ["--effort", options.effort] : []), "--cwd", workspace, "--", briefText];
    const outcome = companionPath ? await runCompanion(companionPath, args, workspace, options.timeoutMs) : { stdout: "", exit: null, seconds: 0, failure: { type: "start", message: `No ${options.engine} companion found` } };
    const jobId = outcome.failure ? null : jobIdFromStdout(outcome.stdout, options.engine) ?? (outcome.exit !== 0 ? failedJobIdFromState(options.engine, workspace) : null);
    const job = jobId ? await waitForJob(options.engine, jobId) : null;
    let infrastructureFailure = outcome.failure ?? (!jobId ? { type: "job_id", message: "Companion printed no parseable job id" } : !job ? { type: "job_record", message: `Job record ${jobId} could not be read` } : null);
    let verifyExit = null;
    let verdict = infrastructureFailure ? "infra_failure" : options.mode === "consult" ? "unscored" : "fail";
    let resultFile = null;
    let diffFile = null;
    if (!infrastructureFailure && options.mode === "write") {
      git(workspace, ["add", "-A"]);
      diffFile = path.join(options.resultsDir, `${runId}.diff`);
      fs.writeFileSync(diffFile, git(workspace, ["diff", "--cached"]));
      try {
        const verify = await runBounded("bash", [verifyFile, workspace], { cwd: options.resultsDir, env: process.env, timeoutMs: options.verifyTimeoutMs, label: "Verifier" });
        verifyExit = verify.timedOut ? null : verify.exitCode;
        if (verify.timedOut) {
          verdict = "infra_failure";
          infrastructureFailure = { type: "timeout", message: `Verifier timed out after ${options.verifyTimeoutMs} ms` };
        } else {
          verdict = verifyExit === 0 && outcome.exit === 0 && job.status === "done" && !job.failureKind ? "pass" : "fail";
        }
      } catch (error) {
        verdict = "infra_failure";
        infrastructureFailure = { type: "start", message: error.message };
      }
    } else if (!infrastructureFailure) {
      resultFile = path.join(options.resultsDir, `${runId}.result.md`);
      fs.writeFileSync(resultFile, job.resultText ?? "", "utf8");
    }
    const record = {
      schema: "fusion-bench-lane/v1",
      runId,
      taskId: options.taskId,
      mode: options.mode,
      engine: options.engine,
      model: options.model,
      effort: options.effort,
      repetition: options.repetition,
      startedAt,
      finishedAt: new Date().toISOString(),
      wallClockSeconds: outcome.seconds,
      companionPath,
      companionExit: outcome.exit,
      jobId,
      jobState: job?.status ?? null,
      failureKind: job?.failureKind ?? null,
      resolvedModel: job?.resolvedModel ?? job?.observedModel ?? null,
      resolvedEffort: job?.resolvedEffort ?? null,
      billingPool: job?.billingPool ?? null,
      cliVersion: job?.[`${options.engine}Version`] ?? null,
      usage: job?.usage ?? job?.cumulativeTokenUsage ?? null,
      totalCostUsd: job?.totalCostUsd ?? null,
      verifyExit,
      verdict,
      infrastructureFailure,
      resultFile,
      diffFile,
      taskManifestHash
    };
    fs.appendFileSync(path.join(options.resultsDir, "runs.jsonl"), `${JSON.stringify(record)}\n`);
    return record;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n${USAGE}\n`);
  process.exitCode = 2;
}
if (options) {
  attempt(options).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
