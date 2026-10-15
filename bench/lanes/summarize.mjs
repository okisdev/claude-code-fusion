#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { assertManifestPins } from "../lib.mjs";
import { readModelRoutingFile, resolveModelRoutingPath } from "../../plugins/fusion/scripts/lib/model-table.mjs";

function parseArgs(argv) {
  let results = null;
  let routing = null;
  let json = false;
  let propose = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json" && !json) {
      json = true;
    } else if (argv[index] === "--propose" && !propose) {
      propose = true;
    } else if (argv[index] === "--results" && !results && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      results = path.resolve(argv[++index]);
    } else if (argv[index] === "--routing" && !routing && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      routing = path.resolve(argv[++index]);
    } else {
      throw new Error(`Invalid option: ${argv[index]}`);
    }
  }
  if (!results) {
    throw new Error("Missing --results");
  }
  if (routing && !propose) {
    throw new Error("--routing requires --propose");
  }
  return { results, routing, json, propose };
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

function proposalRows(records) {
  const groups = new Map();
  for (const record of records) {
    if (record.schema !== "fusion-bench-lane/v1") {
      throw new Error(`Unexpected record schema: ${record.schema}`);
    }
    if (record.verdict !== "pass" && record.verdict !== "fail") {
      continue;
    }
    const key = JSON.stringify([record.engine, record.model]);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(record);
  }

  const models = [...groups].map(([key, runs]) => {
    const [lane, model] = JSON.parse(key);
    const judgedRuns = runs.filter((run) => run.verdict === "pass" || run.verdict === "fail");
    return {
      lane,
      model,
      runs: judgedRuns.length,
      passRate: judgedRuns.filter((run) => run.verdict === "pass").length / judgedRuns.length,
      medianWallClockSeconds: median(judgedRuns.map((run) => run.wallClockSeconds))
    };
  }).filter((model) => model.runs >= 3);

  const laneRates = new Map();
  for (const model of models) {
    if (!laneRates.has(model.lane)) {
      laneRates.set(model.lane, []);
    }
    laneRates.get(model.lane).push(model.passRate);
  }
  return models.map((model) => ({
    ...model,
    laneMedianPassRate: median(laneRates.get(model.lane)),
    suggestion: null,
    suggestionReason: null
  })).sort((a, b) => String(a.lane).localeCompare(String(b.lane)) || String(a.model).localeCompare(String(b.model)));
}

function addSuggestions(rows, routingData) {
  for (const row of rows) {
    const difference = row.passRate - row.laneMedianPassRate;
    if (Math.abs(difference) < 0.25) {
      continue;
    }
    const configured = routingData.models.find((model) => model.id === row.model && model.lane === row.lane);
    if (!configured) {
      row.suggestionReason = "No matching model score in routing file";
      continue;
    }
    const intelligence = Math.max(1, Math.min(5, configured.intelligence + Math.sign(difference)));
    row.suggestion = `/fusion:config rescore ${row.model} --intelligence ${intelligence}`;
  }
}

function proposalReport(rows, json) {
  if (json) {
    return JSON.stringify({
      reviewRequired: true,
      writesFiles: false,
      proposals: rows
    }, null, 2);
  }
  const headers = ["lane", "model", "runs", "pass rate", "median wall clock seconds", "lane median pass rate", "suggestion"];
  const cell = (value) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
  const lines = [
    "Suggestions require human review; this command does not write any files.",
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${[
      row.lane,
      row.model,
      row.runs,
      `${(row.passRate * 100).toFixed(1)}%`,
      row.medianWallClockSeconds,
      `${(row.laneMedianPassRate * 100).toFixed(1)}%`,
      row.suggestion ?? row.suggestionReason ?? "-"
    ].map(cell).join(" | ")} |`)
  ];
  if (!rows.length) {
    lines.push("No models have at least 3 judged runs.");
  }
  return lines.join("\n");
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
  const env = JSON.parse(fs.readFileSync(path.join(options.results, "env.json"), "utf8"));
  assertManifestPins(env, records, options.results);
  if (options.propose) {
    const rows = proposalRows(records);
    if (rows.some((row) => Math.abs(row.passRate - row.laneMedianPassRate) >= 0.25)) {
      const routingPath = options.routing ?? resolveModelRoutingPath(process.env);
      const result = readModelRoutingFile(routingPath);
      if (!result.ok) {
        throw new Error(`Cannot read routing scores from ${routingPath}: ${result.reason}`);
      }
      addSuggestions(rows, result.data);
    }
    process.stdout.write(`${proposalReport(rows, options.json)}\n`);
  } else {
    const rows = summarize(records);
    process.stdout.write(`${options.json ? JSON.stringify(rows, null, 2) : markdown(rows)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
