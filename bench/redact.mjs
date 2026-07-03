#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REDACTED = "[redacted]";

function emptyCounts() {
  return {
    home: 0,
    openai_sk: 0,
    github: 0,
    xai: 0,
    napi: 0,
    aws: 0,
    bearer: 0,
    json_secret: 0,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAll(text, regex, onMatch) {
  let count = 0;
  const next = text.replace(regex, (...args) => {
    count += 1;
    return onMatch(...args);
  });
  return { text: next, count };
}

export function redactText(input, options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const counts = emptyCounts();
  let text = String(input ?? "");

  if (homeDir) {
    const homePattern = new RegExp(`${escapeRegExp(homeDir)}(?=/|$)`, "g");
    const homeLiteral = replaceAll(text, homePattern, () => "~");
    text = homeLiteral.text;
    counts.home += homeLiteral.count;
  }

  const usersHome = replaceAll(text, /\/Users\/[^/\s"']+\//g, () => "~/");
  text = usersHome.text;
  counts.home += usersHome.count;

  const linuxHome = replaceAll(text, /\/home\/[^/\s"']+\//g, () => "~/");
  text = linuxHome.text;
  counts.home += linuxHome.count;

  const rules = [
    ["openai_sk", /sk-[A-Za-z0-9_-]{16,}/g],
    ["github", /(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{20,}/g],
    ["xai", /xai-[A-Za-z0-9]{16,}/g],
    ["napi", /napi_[A-Za-z0-9]{16,}/g],
    ["aws", /AKIA[0-9A-Z]{16}/g],
  ];

  for (const [key, pattern] of rules) {
    const applied = replaceAll(text, pattern, () => REDACTED);
    text = applied.text;
    counts[key] += applied.count;
  }

  const bearer = replaceAll(text, /Bearer\s+(\S{20,})/g, () => `Bearer ${REDACTED}`);
  text = bearer.text;
  counts.bearer += bearer.count;

  const jsonSecret = replaceAll(
    text,
    /"(authorization|api_key|apiKey|token)"\s*:\s*"([^"]{16,})"/g,
    (_match, key) => `"${key}": "${REDACTED}"`,
  );
  text = jsonSecret.text;
  counts.json_secret += jsonSecret.count;

  return { text, counts };
}

function isBinaryBuffer(buffer) {
  return buffer.includes(0);
}

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

export function redactDirectory(targetDir) {
  const root = path.resolve(targetDir);
  if (!fs.existsSync(root)) {
    throw new Error(`Directory not found: ${root}`);
  }
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }

  const summary = {
    filesScanned: 0,
    filesChanged: 0,
    binarySkipped: 0,
    counts: emptyCounts(),
  };

  for (const filePath of walkFiles(root)) {
    summary.filesScanned += 1;
    const buffer = fs.readFileSync(filePath);
    if (isBinaryBuffer(buffer)) {
      summary.binarySkipped += 1;
      continue;
    }
    const original = buffer.toString("utf8");
    const { text, counts } = redactText(original);
    for (const key of Object.keys(summary.counts)) {
      summary.counts[key] += counts[key];
    }
    if (text !== original) {
      fs.writeFileSync(filePath, text, "utf8");
      summary.filesChanged += 1;
    }
  }

  return summary;
}

function printSummary(summary) {
  const lines = [
    `files scanned: ${summary.filesScanned}`,
    `files changed: ${summary.filesChanged}`,
    `home: ${summary.counts.home}`,
    `openai_sk: ${summary.counts.openai_sk}`,
    `github: ${summary.counts.github}`,
    `xai: ${summary.counts.xai}`,
    `napi: ${summary.counts.napi}`,
    `aws: ${summary.counts.aws}`,
    `bearer: ${summary.counts.bearer}`,
    `json_secret: ${summary.counts.json_secret}`,
    `binary skipped: ${summary.binarySkipped}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write("Usage: node bench/redact.mjs <dir>\n");
    process.exit(1);
  }
  try {
    const summary = redactDirectory(target);
    printSummary(summary);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}