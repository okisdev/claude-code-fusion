#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const BENCH_DIR = path.dirname(SELF_PATH);
const SCHEMA_PATH = path.join(BENCH_DIR, "schema", "run-record.schema.json");
const CONDITION_ORDER = ["A", "B1", "B2"];
const MIN_PASSES_FOR_COMPARISON = 2;

function loadSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
}

function typeMatches(type, value) {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function resolveSchema(schema, root) {
  if (!schema.$ref) {
    return schema;
  }
  const parts = schema.$ref.replace(/^#\//, "").split("/");
  let node = root;
  for (const part of parts) {
    node = node[part];
  }
  return node;
}

function validateAgainst(schema, value, root, pathLabel, errors) {
  const resolved = resolveSchema(schema, root);

  if (resolved.oneOf) {
    const matches = resolved.oneOf.some((sub) => {
      const subErrors = [];
      validateAgainst(sub, value, root, pathLabel, subErrors);
      return subErrors.length === 0;
    });
    if (!matches) {
      errors.push(`${pathLabel}: does not match any allowed shape`);
    }
    return;
  }

  const types = Array.isArray(resolved.type) ? resolved.type : resolved.type ? [resolved.type] : null;
  if (types && !types.some((type) => typeMatches(type, value))) {
    errors.push(`${pathLabel}: expected type ${types.join(" or ")}, got ${JSON.stringify(value)}`);
    return;
  }

  if (resolved.enum && !resolved.enum.some((allowed) => allowed === value)) {
    errors.push(`${pathLabel}: ${JSON.stringify(value)} is not one of the allowed values`);
    return;
  }

  if (types && types.includes("object") && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const properties = resolved.properties ?? {};
    const required = resolved.required ?? [];
    for (const key of required) {
      if (!(key in value)) {
        errors.push(`${pathLabel}.${key}: missing required property`);
      }
    }
    if (resolved.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(`${pathLabel}.${key}: unexpected property`);
        }
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in value) {
        validateAgainst(subSchema, value[key], root, `${pathLabel}.${key}`, errors);
      }
    }
    if (resolved.additionalProperties && typeof resolved.additionalProperties === "object") {
      for (const [key, subValue] of Object.entries(value)) {
        if (!(key in properties)) {
          validateAgainst(resolved.additionalProperties, subValue, root, `${pathLabel}.${key}`, errors);
        }
      }
    }
  }
}

function validateRunRecord(schema, record) {
  const errors = [];
  validateAgainst(schema, record, schema, "record", errors);
  return errors;
}

function readRunsJsonl(schema, resultsDir) {
  const file = path.join(resultsDir, "runs.jsonl");
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const records = [];
  const malformed = [];

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    const lineNumber = index + 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      malformed.push({ lineNumber, reason: `invalid JSON: ${error.message}` });
      return;
    }
    const errors = validateRunRecord(schema, parsed);
    if (errors.length > 0) {
      malformed.push({ lineNumber, reason: errors.join("; ") });
      return;
    }
    records.push(parsed);
  });

  return { records, malformed };
}

function readEnv(resultsDir) {
  return JSON.parse(fs.readFileSync(path.join(resultsDir, "env.json"), "utf8"));
}

function conditionRank(condition) {
  const index = CONDITION_ORDER.indexOf(condition);
  return index === -1 ? CONDITION_ORDER.length : index;
}

function groupKey(record) {
  return `${record.taskId}::${record.condition}`;
}

function groupRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = groupKey(record);
    if (!groups.has(key)) {
      groups.set(key, { taskId: record.taskId, condition: record.condition, records: [] });
    }
    groups.get(key).records.push(record);
  }
  return [...groups.values()].sort((left, right) => {
    if (left.taskId !== right.taskId) {
      return left.taskId.localeCompare(right.taskId);
    }
    return conditionRank(left.condition) - conditionRank(right.condition);
  });
}

function median(sortedValues) {
  return percentile(sortedValues, 50);
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) {
    return null;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const rank = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const fraction = rank - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * fraction;
}

function describe(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: median(sorted),
    q1: percentile(sorted, 25),
    q3: percentile(sorted, 75),
    min: sorted[0],
    max: sorted[sorted.length - 1]
  };
}

function formatNumber(value) {
  if (value === null || value === undefined) {
    return "n/a";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function totalOutputTokens(record) {
  return record.claudeTokens.orchestrator.output + record.claudeTokens.subagents.output;
}

function totalInputTokens(record) {
  return record.claudeTokens.orchestrator.input + record.claudeTokens.subagents.input;
}

function buildPassMatrix(groups) {
  const maxRepetition = groups.reduce((max, group) => {
    const groupMax = group.records.reduce((inner, record) => Math.max(inner, record.repetition), 0);
    return Math.max(max, groupMax);
  }, 0);

  const header = ["task", "condition", ...Array.from({ length: maxRepetition }, (_, i) => `rep ${i + 1}`), "passes"];
  const rows = [header, header.map(() => "---")];

  for (const group of groups) {
    const byRepetition = new Map(group.records.map((record) => [record.repetition, record]));
    const cells = [];
    let passCount = 0;
    for (let repetition = 1; repetition <= maxRepetition; repetition += 1) {
      const record = byRepetition.get(repetition);
      if (!record) {
        cells.push("-");
        continue;
      }
      const passed = record.verifyExit === 0;
      if (passed) {
        passCount += 1;
      }
      cells.push(passed ? "pass" : "fail");
    }
    rows.push([group.taskId, group.condition, ...cells, `${passCount}/${group.records.length}`]);
  }

  return rows;
}

function renderTable(rows) {
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function buildWallClockTable(groups) {
  const header = ["task", "condition", "runs", "median (s)", "IQR (s)", "min (s)", "max (s)"];
  const rows = [header, header.map(() => "---")];

  for (const group of groups) {
    const values = group.records.map((record) => record.wallClockSeconds);
    const stats = describe(values);
    rows.push([
      group.taskId,
      group.condition,
      String(group.records.length),
      formatNumber(stats.median),
      `${formatNumber(stats.q1)} to ${formatNumber(stats.q3)}`,
      formatNumber(stats.min),
      formatNumber(stats.max)
    ]);
  }

  return rows;
}

function buildTokenTable(groups) {
  const header = [
    "task",
    "condition",
    "passing",
    "output median",
    "output IQR",
    "output min",
    "output max",
    "input median",
    "input IQR",
    "input min",
    "input max"
  ];
  const rows = [header, header.map(() => "---")];

  for (const group of groups) {
    const passing = group.records.filter((record) => record.verifyExit === 0);
    const passLabel = `${passing.length}/${group.records.length}`;

    if (passing.length < MIN_PASSES_FOR_COMPARISON) {
      rows.push([group.taskId, group.condition, passLabel, "not comparable", "not comparable", "not comparable", "not comparable", "not comparable", "not comparable", "not comparable", "not comparable"]);
      continue;
    }

    const outputStats = describe(passing.map(totalOutputTokens));
    const inputStats = describe(passing.map(totalInputTokens));

    rows.push([
      group.taskId,
      group.condition,
      passLabel,
      formatNumber(outputStats.median),
      `${formatNumber(outputStats.q1)} to ${formatNumber(outputStats.q3)}`,
      formatNumber(outputStats.min),
      formatNumber(outputStats.max),
      formatNumber(inputStats.median),
      `${formatNumber(inputStats.q1)} to ${formatNumber(inputStats.q3)}`,
      formatNumber(inputStats.min),
      formatNumber(inputStats.max)
    ]);
  }

  return rows;
}

function buildExcludedSection(records) {
  const excluded = records.filter((record) => record.excluded);
  if (excluded.length === 0) {
    return ["### Excluded runs", "", "No excluded runs."].join("\n");
  }
  const header = ["task", "condition", "repetition", "reason"];
  const rows = [header, header.map(() => "---")];
  for (const record of excluded) {
    rows.push([record.taskId, record.condition, String(record.repetition), record.excludedReason ?? "unspecified"]);
  }
  return ["### Excluded runs", "", renderTable(rows)].join("\n");
}

function buildMalformedSection(malformed) {
  if (malformed.length === 0) {
    return ["### Malformed records", "", "No malformed records."].join("\n");
  }
  const lines = malformed.map((entry) => `- runs.jsonl:${entry.lineNumber}: ${entry.reason}`);
  return ["### Malformed records", "", ...lines].join("\n");
}

function buildSuiteAggregate(nonExcludedRecords) {
  const taskCount = new Set(nonExcludedRecords.map((record) => record.taskId)).size;
  const passCount = nonExcludedRecords.filter((record) => record.verifyExit === 0).length;
  const totalCount = nonExcludedRecords.length;
  const passingRecords = nonExcludedRecords.filter((record) => record.verifyExit === 0);

  const lines = [
    "## Suite level aggregate",
    "",
    `- Tasks represented: ${taskCount}`,
    `- Total non excluded runs: ${totalCount}`,
    `- Overall pass rate: ${passCount}/${totalCount}${totalCount > 0 ? ` (${((passCount / totalCount) * 100).toFixed(1)}%)` : ""}`
  ];

  if (passingRecords.length > 0) {
    const wallClock = describe(passingRecords.map((record) => record.wallClockSeconds));
    const output = describe(passingRecords.map(totalOutputTokens));
    const input = describe(passingRecords.map(totalInputTokens));
    lines.push(
      `- Median wall clock across passing runs: ${formatNumber(wallClock.median)}s`,
      `- Median output tokens across passing runs: ${formatNumber(output.median)}`,
      `- Median input tokens across passing runs: ${formatNumber(input.median)}`
    );
  }

  lines.push("", "These aggregates are descriptive summaries of the tasks above, not a statistical claim.");
  return lines.join("\n");
}

function buildReportForDir(schema, resultsDir) {
  const env = readEnv(resultsDir);
  const { records, malformed } = readRunsJsonl(schema, resultsDir);
  const nonExcluded = records.filter((record) => !record.excluded);
  const groups = groupRecords(nonExcluded);

  const lines = [
    `## ${path.basename(resultsDir)}`,
    "",
    `Manifest hash: ${env.manifestHash ?? "unknown"}`,
    "",
    "### Pass matrix",
    "",
    renderTable(buildPassMatrix(groups)),
    "",
    "### Wall clock statistics",
    "",
    renderTable(buildWallClockTable(groups)),
    "",
    "### Token statistics",
    "",
    renderTable(buildTokenTable(groups)),
    "",
    buildExcludedSection(records),
    "",
    buildMalformedSection(malformed),
    "",
    buildSuiteAggregate(nonExcluded)
  ];

  return lines.join("\n");
}

function main() {
  const resultsDirs = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

  if (resultsDirs.length === 0 || resultsDirs.length > 2) {
    console.error("Usage: node bench/summarize.mjs <resultsDir> [<resultsDir2>]");
    process.exitCode = 1;
    return;
  }

  if (resultsDirs.length === 2) {
    const [envA, envB] = resultsDirs.map(readEnv);
    if (envA.manifestHash !== envB.manifestHash) {
      console.error(
        `Refusing to compare results with different manifest hashes: ${envA.manifestHash ?? "unknown"} (${resultsDirs[0]}) vs ${envB.manifestHash ?? "unknown"} (${resultsDirs[1]}).`
      );
      process.exitCode = 1;
      return;
    }
  }

  const schema = loadSchema();
  const sections = resultsDirs.map((resultsDir) => buildReportForDir(schema, resultsDir));

  console.log(["# Benchmark summary", "", ...sections].join("\n"));
}

main();
