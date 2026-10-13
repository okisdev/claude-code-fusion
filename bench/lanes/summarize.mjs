#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  let results = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json" && !json) {
      json = true;
    } else if (argv[index] === "--results" && !results && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      results = path.resolve(argv[++index]);
    } else {
      throw new Error(`Invalid option: ${argv[index]}`);
    }
  }
  if (!results) {
    throw new Error("Missing --results");
  }
  return { results, json };
}

function median(values) {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function tokens(usage, camel, snake) {
  return usage?.[camel] ?? usage?.[snake] ?? null;
}

function summarize(records) {
  const groups = new Map();
  for (const record of records) {
    if (record.schema !== "fusion-bench-lane/v1") {
      throw new Error(`Unexpected record schema: ${record.schema}`);
    }
    const key = JSON.stringify([record.taskId, record.engine, record.model, record.effort]);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(record);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([key, runs]) => {
    const [taskId, engine, model, effort] = JSON.parse(key);
    const kinds = new Map();
    for (const run of runs) {
      if (run.failureKind) {
        kinds.set(run.failureKind, (kinds.get(run.failureKind) ?? 0) + 1);
      }
    }
    return {
      taskId,
      engine,
      model,
      effort,
      runs: runs.length,
      pass: runs.filter((run) => run.verdict === "pass").length,
      fail: runs.filter((run) => run.verdict === "fail").length,
      infra: runs.filter((run) => run.verdict === "infra_failure").length,
      unscored: runs.filter((run) => run.verdict === "unscored").length,
      medianWallClockSeconds: median(runs.map((run) => run.wallClockSeconds)),
      medianInputTokens: median(runs.map((run) => tokens(run.usage, "inputTokens", "input_tokens"))),
      medianOutputTokens: median(runs.map((run) => tokens(run.usage, "outputTokens", "output_tokens"))),
      failureKinds: [...kinds].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind}:${count}`).join(", ")
    };
  });
}

function markdown(rows) {
  const columns = ["taskId", "engine", "model", "effort", "runs", "pass", "fail", "infra", "unscored", "medianWallClockSeconds", "medianInputTokens", "medianOutputTokens", "failureKinds"];
  const headers = ["taskId", "engine", "model", "effort", "runs", "pass", "fail", "infra", "unscored", "median wall clock seconds", "median input tokens", "median output tokens", "failure kinds"];
  const cell = (value) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${columns.map((column) => cell(row[column])).join(" | ")} |`)].join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  const records = fs.readFileSync(path.join(options.results, "runs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const rows = summarize(records);
  process.stdout.write(`${options.json ? JSON.stringify(rows, null, 2) : markdown(rows)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
