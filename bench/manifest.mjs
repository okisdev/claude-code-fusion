#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TASKS_DIR = path.join(process.cwd(), "bench", "tasks");
const MANIFEST_PATH = path.join(TASKS_DIR, "manifest.json");

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function canonicalTasksString(tasks) {
  return JSON.stringify(tasks);
}

function manifestHash(tasks) {
  return createHash("sha256").update(canonicalTasksString(tasks)).digest("hex");
}

function scanTasks() {
  if (!fs.existsSync(TASKS_DIR)) {
    return [];
  }
  const entries = fs
    .readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const tasks = [];
  for (const id of entries) {
    const taskDir = path.join(TASKS_DIR, id);
    const briefFile = path.join(taskDir, "brief.md");
    const verifyFile = path.join(taskDir, "verify.sh");
    if (!fs.existsSync(briefFile) || !fs.existsSync(verifyFile)) {
      continue;
    }
    tasks.push({
      id,
      briefSha256: sha256File(briefFile),
      verifySha256: sha256File(verifyFile)
    });
  }
  return tasks;
}

function writeManifest(tasks) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const manifest = { tasks };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return null;
  }
}

function diffTasks(expected, actual) {
  const expectedById = new Map(expected.map((task) => [task.id, task]));
  const actualById = new Map(actual.map((task) => [task.id, task]));
  const drifted = [];

  for (const id of expectedById.keys()) {
    if (!actualById.has(id)) {
      drifted.push(`${id}: removed from bench/tasks/`);
      continue;
    }
    const expectedTask = expectedById.get(id);
    const actualTask = actualById.get(id);
    if (expectedTask.briefSha256 !== actualTask.briefSha256) {
      drifted.push(`${id}: brief.md changed`);
    }
    if (expectedTask.verifySha256 !== actualTask.verifySha256) {
      drifted.push(`${id}: verify.sh changed`);
    }
  }
  for (const id of actualById.keys()) {
    if (!expectedById.has(id)) {
      drifted.push(`${id}: added to bench/tasks/`);
    }
  }
  return drifted;
}

function runCheck() {
  const actual = scanTasks();
  const existing = readManifest();

  if (!existing) {
    console.error("bench/tasks/manifest.json is missing. Run `node bench/manifest.mjs` to generate it.");
    process.exitCode = 1;
    return;
  }

  const drifted = diffTasks(existing.tasks ?? [], actual);
  if (drifted.length > 0) {
    console.error("bench/tasks/manifest.json is stale:");
    for (const line of drifted) {
      console.error(`- ${line}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`bench/tasks/manifest.json is up to date. manifest hash: ${manifestHash(actual)}`);
}

function runGenerate() {
  const tasks = scanTasks();
  writeManifest(tasks);
  if (tasks.length === 0) {
    console.log("bench/tasks/ is empty or absent; wrote an empty manifest.");
    return;
  }
  console.log(`Wrote bench/tasks/manifest.json with ${tasks.length} task(s). manifest hash: ${manifestHash(tasks)}`);
}

function main() {
  const check = process.argv.slice(2).includes("--check");

  if (check) {
    runCheck();
    return;
  }

  runGenerate();
}

main();
