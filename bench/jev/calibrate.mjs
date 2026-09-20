#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { FLAG_THRESHOLD, QUESTIONS } from "../../plugins/fusion/scripts/brief-sensor.mjs";
import { resolveEngineStateRoots } from "../../plugins/fusion/scripts/lib/engine-job-state.mjs";
import { ENGINE_IDS } from "../../plugins/fusion/scripts/lib/engines.mjs";
import { PINNED_MODEL, askJev } from "../../plugins/fusion/scripts/lib/jev.mjs";

const BRIEFS_FILE = path.join(import.meta.dirname, "briefs.json");
const CHECK_IDS = Object.keys(QUESTIONS);
const CONCURRENCY = 4;
const RETAINED_MIN_CHARS = 200;

function parseArgs(argv) {
  const options = { model: PINNED_MODEL, retained: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--model" && argv[index + 1]) {
      options.model = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--retained") {
      options.retained = true;
    } else {
      throw new Error("usage: node bench/jev/calibrate.mjs [--model <id>] [--retained]");
    }
  }
  return options;
}

function retainedAcceptedBriefs(env) {
  const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
  const briefs = [];
  for (const engine of ENGINE_IDS) {
    for (const stateRoot of resolveEngineStateRoots(engine, env)) {
      let workspaces = [];
      try {
        workspaces = fs.readdirSync(stateRoot);
      } catch {
        continue;
      }
      for (const workspace of workspaces) {
        let jobFiles = [];
        try {
          jobFiles = fs.readdirSync(path.join(stateRoot, workspace, "jobs"));
        } catch {
          continue;
        }
        for (const jobFile of jobFiles.filter((name) => name.endsWith(".json"))) {
          try {
            const record = JSON.parse(fs.readFileSync(path.join(stateRoot, workspace, "jobs", jobFile), "utf8"));
            const root = record.workspaceRoot ?? record.cwd ?? "";
            if (record.status !== "done" || record.semanticStatus !== "accepted" || (root !== repository && !root.startsWith(`${repository}${path.sep}`))) {
              continue;
            }
            const brief = fs.readFileSync(path.join(stateRoot, workspace, "briefs", `${record.id}.md`), "utf8");
            if (brief.length >= RETAINED_MIN_CHARS && !brief.startsWith("<role>")) {
              briefs.push({ label: "retained", id: `${engine}:${String(record.id).slice(0, 8)}`, brief });
            }
          } catch {
            continue;
          }
        }
      }
    }
  }
  return briefs;
}

async function scoreAll(items, model) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const startedAt = performance.now();
      const answers = await askJev(items[index].brief, QUESTIONS, { model });
      const complete = answers && CHECK_IDS.every((id) => Number.isFinite(answers[id]?.noul));
      results[index] = { ...items[index], ms: Math.round(performance.now() - startedAt), scores: complete ? Object.fromEntries(CHECK_IDS.map((id) => [id, answers[id].noul])) : null };
    }
  }));
  return results;
}

function flaggedIds(scores) {
  return CHECK_IDS.filter((id) => Number.isFinite(scores[id]) && scores[id] >= FLAG_THRESHOLD);
}

function fixtureVerdict(result) {
  if (!result.scores) {
    return "no answer";
  }
  const flagged = flaggedIds(result.scores);
  if (result.label === "clean") {
    return flagged.length === 0 ? "ok" : `false positive: ${flagged.join(", ")}`;
  }
  return flagged.includes(result.label) ? "ok" : `missed at ${result.scores[result.label]}`;
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    console.error("TYPESAFE_API_KEY is not set.");
    process.exitCode = 2;
    return;
  }
  const fixtures = JSON.parse(fs.readFileSync(BRIEFS_FILE, "utf8"));
  const retained = options.retained ? retainedAcceptedBriefs(process.env) : [];
  const results = await scoreAll([...fixtures, ...retained], options.model);
  const fixtureResults = results.slice(0, fixtures.length);
  const retainedAll = results.slice(fixtures.length);
  const retainedResults = retainedAll.filter((result) => result.scores);

  console.log(`model ${options.model}, threshold ${FLAG_THRESHOLD}, pinned ${PINNED_MODEL}`);
  let failures = 0;
  for (const result of fixtureResults) {
    const verdict = fixtureVerdict(result);
    failures += verdict === "ok" ? 0 : 1;
    console.log(`${result.label.padEnd(15)} ${verdict.padEnd(28)} ${result.scores ? CHECK_IDS.map((id) => `${id}=${result.scores[id]}`).join(" ") : ""}`);
  }
  if (options.retained) {
    const flagged = retainedResults.filter((result) => flaggedIds(result.scores).length > 0);
    console.log(`retained accepted briefs: ${retainedResults.length} scored, ${retainedAll.length - retainedResults.length} unanswered, ${flagged.length} flagged${flagged.length > 0 ? ` (${flagged.map((result) => `${result.id} ${flaggedIds(result.scores).join("+")}`).join(", ")})` : ""}`);
  }
  const latencies = results.filter((result) => result.scores).map((result) => result.ms).sort((left, right) => left - right);
  if (latencies.length > 0) {
    console.log(`latency ms p50 ${percentile(latencies, 0.5)} p99 ${percentile(latencies, 0.99)} over ${latencies.length} calls`);
  }
  console.log(failures === 0 ? "calibration holds" : `calibration failed on ${failures} of ${fixtureResults.length} fixtures`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
