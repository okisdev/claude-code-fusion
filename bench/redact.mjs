#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REDACTED = "[redacted]";

export const redactionRules = [
  {
    id: "home",
    pattern: ({ homeDir }) => homeDir ? new RegExp(`${escapeRegExp(homeDir)}(?=/|$)`, "g") : null,
    replacement: () => "~",
  },
  {
    id: "home",
    pattern: /\/Users\/[^/\s"']+\//g,
    replacement: () => "~/",
  },
  {
    id: "home",
    pattern: /\/home\/[^/\s"']+\//g,
    replacement: () => "~/",
  },
  {
    id: "openai_sk",
    pattern: /sk-[A-Za-z0-9_-]{16,}/g,
    replacement: () => REDACTED,
  },
  {
    id: "github",
    pattern: /(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{20,}/g,
    replacement: () => REDACTED,
  },
  {
    id: "xai",
    pattern: /xai-[A-Za-z0-9]{16,}/g,
    replacement: () => REDACTED,
  },
  {
    id: "napi",
    pattern: /napi_[A-Za-z0-9]{16,}/g,
    replacement: () => REDACTED,
  },
  {
    id: "aws",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: () => REDACTED,
  },
  {
    id: "bearer",
    pattern: /Bearer\s+(\S{20,})/g,
    replacement: () => `Bearer ${REDACTED}`,
  },
  {
    id: "json_secret",
    pattern: /"(authorization|api_key|apiKey|token)"\s*:\s*"([^"]{16,})"/g,
    replacement: (_match, key) => `"${key}": "${REDACTED}"`,
  },
];

function emptyCounts() {
  const counts = {};
  for (const rule of redactionRules) {
    counts[rule.id] ??= 0;
  }
  return counts;
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

function applyRule(text, rule, context) {
  const pattern = typeof rule.pattern === "function" ? rule.pattern(context) : rule.pattern;
  if (!pattern) {
    return { text, count: 0 };
  }
  const replacement = typeof rule.replacement === "function" ? rule.replacement : () => rule.replacement;
  return replaceAll(text, pattern, replacement);
}

export function redactText(input, options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const context = { homeDir };
  const counts = emptyCounts();
  let text = String(input ?? "");

  for (const rule of redactionRules) {
    counts[rule.id] ??= 0;
    const applied = applyRule(text, rule, context);
    text = applied.text;
    counts[rule.id] += applied.count;
  }

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
    for (const [key, count] of Object.entries(counts)) {
      summary.counts[key] = (summary.counts[key] ?? 0) + count;
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
    ...Object.entries(summary.counts).map(([key, count]) => `${key}: ${count}`),
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
