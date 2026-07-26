#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [, , target_dir] = process.argv;

if (process.argv.length !== 3 || !target_dir) {
  console.error("usage: node check-style.mjs <dir>");
  process.exit(2);
}

if (!fs.existsSync(target_dir) || !fs.statSync(target_dir).isDirectory()) {
  console.error(`directory is not a directory: ${target_dir}`);
  process.exit(2);
}

function list_javascript_files(directory) {
  const files = [];
  const directories = [directory];

  while (directories.length > 0) {
    const current_directory = directories.pop();
    const entries = fs.readdirSync(current_directory, { withFileTypes: true });
    for (const entry of entries) {
      const entry_path = path.join(current_directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") {
          directories.push(entry_path);
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(entry_path);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function find_violations(file_path) {
  const violations = [];
  const lines = fs.readFileSync(file_path, "utf8").split(/\r?\n/);
  const relative_path = path.relative(target_dir, file_path).split(path.sep).join("/");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const line_number = index + 1;
    if (/\basync\b/.test(line) || /\bawait\b/.test(line)) {
      violations.push(`${relative_path}:${line_number}: async or await keyword`);
    }
    if (/\bclass\s/.test(line)) {
      violations.push(`${relative_path}:${line_number}: class declaration`);
    }
    if (/new\s+Error\s*\(/.test(line)) {
      violations.push(`${relative_path}:${line_number}: new Error construction`);
    }
    if (/\/\//.test(line) || /\/\*/.test(line)) {
      violations.push(`${relative_path}:${line_number}: comment`);
    }
    if (/export\s+default\b/.test(line)) {
      violations.push(`${relative_path}:${line_number}: default export`);
    }

    const exports = line.matchAll(/\bexport\s+(?:function|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g);
    for (const match of exports) {
      if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(match[1])) {
        violations.push(`${relative_path}:${line_number}: exported identifier is not snake_case`);
      }
    }
  }

  return violations;
}

const violations = list_javascript_files(target_dir).flatMap(find_violations);

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(violation);
  }
  process.exit(1);
}
