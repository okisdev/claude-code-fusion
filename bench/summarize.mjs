#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const BENCH_DIR = path.dirname(SELF_PATH);
const SCHEMA_PATH = path.join(BENCH_DIR, "schema", "run-record.schema.json");
const CONDITION_ORDER = ["A", "B1", "B2", "B3"];
const MIN_PASSES_FOR_COMPARISON = 2;
const EXCLUSION_CAP = 0.05;

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

  if (typeof value === "number" && typeof resolved.minimum === "number" && value < resolved.minimum) {
    errors.push(`${pathLabel}: expected at least ${resolved.minimum}, got ${value}`);
  }

  if (typeof value === "string" && typeof resolved.minLength === "number" && value.length < resolved.minLength) {
    errors.push(`${pathLabel}: expected length at least ${resolved.minLength}`);
  }

  if (typeof value === "string" && typeof resolved.pattern === "string" && !new RegExp(resolved.pattern).test(value)) {
    errors.push(`${pathLabel}: does not match pattern ${resolved.pattern}`);
  }

  if (typeof value === "string" && resolved.format === "date-time" && Number.isNaN(Date.parse(value))) {
    errors.push(`${pathLabel}: expected date-time string`);
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

  if (types && types.includes("array") && Array.isArray(value)) {
    if (typeof resolved.minItems === "number" && value.length < resolved.minItems) {
      errors.push(`${pathLabel}: expected at least ${resolved.minItems} item(s)`);
    }
    if (resolved.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) {
        errors.push(`${pathLabel}: expected unique items`);
      }
    }
    if (resolved.items) {
      value.forEach((item, index) => validateAgainst(resolved.items, item, root, `${pathLabel}[${index}]`, errors));
    }
  }
}

function validateRunRecord(schema, record) {
  const errors = [];
  validateAgainst(schema, record, schema, "record", errors);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return errors;
  }
  if (record.excluded === true && record.excludedReason === null) {
    errors.push("record.excludedReason: required when excluded is true");
  }
  if (record.excluded === false && record.excludedReason !== null) {
    errors.push("record.excludedReason: expected null when excluded is false");
  }
  if (record.condition === "B2" && (record.peerTokens === null || typeof record.peerTokens !== "object")) {
    errors.push("record.peerTokens: required for condition B2");
  }
  if (["A", "B1", "B3"].includes(record.condition) && record.peerTokens !== null) {
    errors.push(`record.peerTokens: expected null for condition ${record.condition}`);
  }
  if (record.condition === "B2" && (record.peerDefaults === null || typeof record.peerDefaults !== "object")) {
    errors.push("record.peerDefaults: required for condition B2");
  }
  if (record.verdict === "infra_failure" && record.infraFailure === null) {
    errors.push("record.infraFailure: required when verdict is infra_failure");
  }
  if ((record.verdict === "pass" || record.verdict === "fail") && record.infraFailure !== null) {
    errors.push("record.infraFailure: expected null when verdict is not infra_failure");
  }
  if (record.verdict === "pass" && record.verifyExit !== 0) {
    errors.push("record.verifyExit: expected 0 when verdict is pass");
  }
  if (record.verdict === "fail" && (record.verifyExit === null || record.verifyExit === 0)) {
    errors.push("record.verifyExit: expected nonzero when verdict is fail");
  }
  if (typeof record.startedAt === "string" && typeof record.finishedAt === "string") {
    const started = Date.parse(record.startedAt);
    const finished = Date.parse(record.finishedAt);
    if (!Number.isNaN(started) && !Number.isNaN(finished) && finished < started) {
      errors.push("record.finishedAt: expected to be at or after startedAt");
    }
  }
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

function isPassing(record) {
  return record.verdict === "pass";
}

function isInvalidForClaims(record) {
  return (record.condition === "B1" || record.condition === "B2") && record.delegationCount === 0;
}

function isClaimEligiblePassing(record) {
  return isPassing(record) && !isInvalidForClaims(record);
}

function totalTokenCounts(counts) {
  return counts.input + counts.output + counts.cacheRead + counts.cacheCreation;
}

function totalOutputTokens(record) {
  return record.claudeTokens.orchestrator.output + record.claudeTokens.subagents.output;
}

function totalInputTokens(record) {
  return record.claudeTokens.orchestrator.input + record.claudeTokens.subagents.input;
}

function totalClaudeBilledTokens(record) {
  return totalTokenCounts(record.claudeTokens.orchestrator) + totalTokenCounts(record.claudeTokens.subagents);
}

function passMatrixCell(record) {
  if (record.verdict === "infra_failure") {
    return "infra_failure";
  }
  return isPassing(record) ? "pass" : "fail";
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
      const passed = isPassing(record);
      if (passed) {
        passCount += 1;
      }
      cells.push(passMatrixCell(record));
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
    "billed median",
    "billed IQR",
    "billed min",
    "billed max",
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
    const passing = group.records.filter(isPassing);
    const passLabel = `${passing.length}/${group.records.length}`;

    if (passing.length < MIN_PASSES_FOR_COMPARISON) {
      rows.push([group.taskId, group.condition, passLabel, "not comparable", "not comparable", "not comparable", "not comparable", "not comparable", "not comparable", "not comparable", "not comparable", "not comparable", "not comparable", "not comparable", "not comparable"]);
      continue;
    }

    const billedStats = describe(passing.map(totalClaudeBilledTokens));
    const outputStats = describe(passing.map(totalOutputTokens));
    const inputStats = describe(passing.map(totalInputTokens));

    rows.push([
      group.taskId,
      group.condition,
      passLabel,
      formatNumber(billedStats.median),
      `${formatNumber(billedStats.q1)} to ${formatNumber(billedStats.q3)}`,
      formatNumber(billedStats.min),
      formatNumber(billedStats.max),
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

function buildDelegationSection(records) {
  const bRecords = records.filter((record) => record.condition === "B1" || record.condition === "B2" || record.condition === "B3");
  if (bRecords.length === 0) {
    return ["### Delegation counts", "", "No fusion enabled condition runs."].join("\n");
  }
  const groups = groupRecords(bRecords);
  const maxRepetition = groups.reduce((max, group) => {
    const groupMax = group.records.reduce((inner, record) => Math.max(inner, record.repetition), 0);
    return Math.max(max, groupMax);
  }, 0);
  const header = ["task", "condition", ...Array.from({ length: maxRepetition }, (_, i) => `rep ${i + 1}`), "claim validity"];
  const rows = [header, header.map(() => "---")];
  for (const group of groups) {
    const byRepetition = new Map(group.records.map((record) => [record.repetition, record]));
    const cells = [];
    for (let repetition = 1; repetition <= maxRepetition; repetition += 1) {
      const record = byRepetition.get(repetition);
      cells.push(record ? String(record.delegationCount) : "-");
    }
    const claimValidity = group.records.some(isInvalidForClaims)
      ? "invalid-for-claims"
      : group.condition === "B3" && group.records.some((record) => record.delegationCount === 0)
        ? "valid-zero-delegation"
        : "valid-for-claims";
    rows.push([
      group.taskId,
      group.condition,
      ...cells,
      claimValidity
    ]);
  }
  return ["### Delegation counts", "", renderTable(rows)].join("\n");
}

function mean(values) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recordsForTaskCondition(records, taskId, condition) {
  return records.filter((record) => record.taskId === taskId && record.condition === condition);
}

function comparableTaskDeltas(records, baselineCondition, comparisonCondition, metric) {
  const taskIds = [...new Set(records.map((record) => record.taskId))].sort();
  const deltas = [];
  for (const taskId of taskIds) {
    const baseline = recordsForTaskCondition(records, taskId, baselineCondition).filter(isClaimEligiblePassing);
    const comparison = recordsForTaskCondition(records, taskId, comparisonCondition).filter(isClaimEligiblePassing);
    if (baseline.length < MIN_PASSES_FOR_COMPARISON || comparison.length < MIN_PASSES_FOR_COMPARISON) {
      continue;
    }
    const baselineMedian = median(baseline.map(metric).sort((left, right) => left - right));
    const comparisonMedian = median(comparison.map(metric).sort((left, right) => left - right));
    deltas.push(comparisonMedian - baselineMedian);
  }
  return deltas;
}

function formatDeltaLine(label, deltas) {
  if (deltas.length === 0) {
    return `- ${label}: not enough comparable passing runs.`;
  }
  const sorted = [...deltas].sort((left, right) => left - right);
  return `- ${label}: mean delta ${formatNumber(mean(deltas))}, median delta ${formatNumber(median(sorted))}, tasks ${deltas.length}.`;
}

function peerTokenLine(records) {
  const b2Records = records.filter((record) => record.condition === "B2" && isClaimEligiblePassing(record));
  if (b2Records.length === 0) {
    return "- C1b peer tokens: not enough comparable B2 passing runs.";
  }
  if (b2Records.some((record) => record.peerTokens === null || record.peerTokens.grok === null || record.peerTokens.codex === null)) {
    return "- C1b peer tokens: not measurable while peerTokens are null.";
  }
  const totals = b2Records.map((record) => record.peerTokens.grok + record.peerTokens.codex);
  const stats = describe(totals);
  return `- C1b peer tokens: median ${formatNumber(stats.median)}, IQR ${formatNumber(stats.q1)} to ${formatNumber(stats.q3)}.`;
}

function planTaskIds(env) {
  const tagsByTask = env.taskTags && typeof env.taskTags === "object" ? env.taskTags : {};
  return new Set(
    Object.entries(tagsByTask)
      .filter((entry) => Array.isArray(entry[1]) && entry[1].includes("plan-shaped"))
      .map((entry) => entry[0])
  );
}

function wallClockRatioLine(records, planTasks, comparisonCondition) {
  const ratios = [];
  for (const taskId of planTasks) {
    const baseline = recordsForTaskCondition(records, taskId, "A").filter(isClaimEligiblePassing);
    const comparison = recordsForTaskCondition(records, taskId, comparisonCondition).filter(isClaimEligiblePassing);
    if (baseline.length < MIN_PASSES_FOR_COMPARISON || comparison.length < MIN_PASSES_FOR_COMPARISON) {
      continue;
    }
    const baselineMedian = median(baseline.map((record) => record.wallClockSeconds).sort((left, right) => left - right));
    const comparisonMedian = median(comparison.map((record) => record.wallClockSeconds).sort((left, right) => left - right));
    if (baselineMedian > 0) {
      ratios.push(comparisonMedian / baselineMedian);
    }
  }
  if (ratios.length === 0) {
    return `- C2 ${comparisonCondition} versus A wall clock ratio: not enough comparable plan-shaped passing runs.`;
  }
  const sorted = [...ratios].sort((left, right) => left - right);
  return `- C2 ${comparisonCondition} versus A wall clock ratio: mean ${formatNumber(mean(ratios))}, median ${formatNumber(median(sorted))}, tasks ${ratios.length}.`;
}

function buildComparisonsSection(records, env) {
  const claimRecords = records.filter((record) => !record.excluded);
  const c1a = comparableTaskDeltas(claimRecords, "A", "B1", totalClaudeBilledTokens);
  const c1b = comparableTaskDeltas(claimRecords, "B1", "B2", totalClaudeBilledTokens);
  const c1c = comparableTaskDeltas(claimRecords, "B1", "B3", totalClaudeBilledTokens);
  const plans = planTaskIds(env);
  const lines = [
    "### Comparisons",
    "",
    formatDeltaLine("C1a A vs B1 Claude billed tokens, B1 minus A", c1a),
    formatDeltaLine("C1b B1 vs B2 Claude billed tokens, B2 minus B1", c1b),
    formatDeltaLine("C1c B1 vs B3 Claude billed tokens, B3 minus B1", c1c),
    peerTokenLine(claimRecords)
  ];
  if (plans.size === 0) {
    lines.push("- C2: no plan tasks in suite for now.");
  } else {
    lines.push(wallClockRatioLine(claimRecords, plans, "B1"), wallClockRatioLine(claimRecords, plans, "B2"));
  }
  return lines.join("\n");
}

function exclusionCapLine(records) {
  const total = records.length;
  const excluded = records.filter((record) => record.excluded).length;
  const percent = total === 0 ? 0 : excluded / total;
  const label = `Exclusion cap: ${excluded}/${total} (${(percent * 100).toFixed(1)}%).`;
  if (percent > EXCLUSION_CAP) {
    return `${label} Exceeds 5.0%, snapshot invalid as a comparison.`;
  }
  return `${label} Within 5.0%.`;
}

function buildExcludedSection(records) {
  const excluded = records.filter((record) => record.excluded);
  if (excluded.length === 0) {
    return ["### Excluded runs", "", exclusionCapLine(records), "", "No excluded runs."].join("\n");
  }
  const header = ["task", "condition", "repetition", "reason"];
  const rows = [header, header.map(() => "---")];
  for (const record of excluded) {
    rows.push([record.taskId, record.condition, String(record.repetition), record.excludedReason ?? "unspecified"]);
  }
  return ["### Excluded runs", "", exclusionCapLine(records), "", renderTable(rows)].join("\n");
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
  const passCount = nonExcludedRecords.filter(isPassing).length;
  const totalCount = nonExcludedRecords.length;
  const passingRecords = nonExcludedRecords.filter(isPassing);

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
    const billed = describe(passingRecords.map(totalClaudeBilledTokens));
    lines.push(
      `- Median wall clock across passing runs: ${formatNumber(wallClock.median)}s`,
      `- Median billed Claude tokens across passing runs: ${formatNumber(billed.median)}`,
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
    buildDelegationSection(nonExcluded),
    "",
    buildComparisonsSection(records, env),
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
