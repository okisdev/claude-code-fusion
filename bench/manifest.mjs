#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TASKS_DIR = path.join(process.cwd(), "bench", "tasks");
const MANIFEST_PATH = path.join(TASKS_DIR, "manifest.json");

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function canonicalTasksString(tasks) {
  return JSON.stringify(tasks);
}

export function manifestHash(tasks) {
  return createHash("sha256").update(canonicalTasksString(tasks)).digest("hex");
}

function listTaskFiles(taskDir) {
  const files = [];
  const stack = [taskDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push({
        path: path.relative(taskDir, full).split(path.sep).join("/"),
        sha256: sha256File(full)
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function taskHash(files) {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

export function scanTasks(tasksDir = TASKS_DIR) {
  if (!fs.existsSync(tasksDir)) {
    return [];
  }
  const entries = fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const tasks = [];
  for (const id of entries) {
    const taskDir = path.join(tasksDir, id);
    const briefFile = path.join(taskDir, "brief.md");
    const verifyFile = path.join(taskDir, "verify.sh");
    if (!fs.existsSync(briefFile) || !fs.existsSync(verifyFile)) {
      continue;
    }
    const files = listTaskFiles(taskDir);
    tasks.push({
      id,
      taskSha256: taskHash(files),
      files
    });
  }
  return tasks;
}

export function buildManifest(tasksDir = TASKS_DIR) {
  const tasks = scanTasks(tasksDir);
  return {
    manifestHash: manifestHash(tasks),
    tasks
  };
}

function writeManifest(manifest, tasksDir = TASKS_DIR) {
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function readManifest(manifestPath = MANIFEST_PATH) {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
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
    const expectedFiles = new Map((expectedTask.files ?? []).map((file) => [file.path, file.sha256]));
    const actualFiles = new Map((actualTask.files ?? []).map((file) => [file.path, file.sha256]));
    for (const filePath of expectedFiles.keys()) {
      if (!actualFiles.has(filePath)) {
        drifted.push(`${id}: ${filePath} removed`);
        continue;
      }
      if (expectedFiles.get(filePath) !== actualFiles.get(filePath)) {
        drifted.push(`${id}: ${filePath} changed`);
      }
    }
    for (const filePath of actualFiles.keys()) {
      if (!expectedFiles.has(filePath)) {
        drifted.push(`${id}: ${filePath} added`);
      }
    }
    if (expectedTask.taskSha256 !== actualTask.taskSha256) {
      drifted.push(`${id}: task hash changed`);
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
  const actual = buildManifest();
  const existing = readManifest();

  if (!existing) {
    console.error("bench/tasks/manifest.json is missing. Run `node bench/manifest.mjs` to generate it.");
    process.exitCode = 1;
    return;
  }

  const drifted = diffTasks(existing.tasks ?? [], actual.tasks);
  if (existing.manifestHash !== actual.manifestHash) {
    drifted.push(`manifest hash changed from ${existing.manifestHash ?? "missing"} to ${actual.manifestHash}`);
  }
  if (drifted.length > 0) {
    console.error("bench/tasks/manifest.json is stale:");
    for (const line of drifted) {
      console.error(`- ${line}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`bench/tasks/manifest.json is up to date. manifest hash: ${actual.manifestHash}`);
}

function runGenerate() {
  const manifest = buildManifest();
  writeManifest(manifest);
  if (manifest.tasks.length === 0) {
    console.log("bench/tasks/ is empty or absent; wrote an empty manifest.");
    return;
  }
  console.log(`Wrote bench/tasks/manifest.json with ${manifest.tasks.length} task(s). manifest hash: ${manifest.manifestHash}`);
}

function main() {
  const check = process.argv.slice(2).includes("--check");

  if (check) {
    runCheck();
    return;
  }

  runGenerate();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
