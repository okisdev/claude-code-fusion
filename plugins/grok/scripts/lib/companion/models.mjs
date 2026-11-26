import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGrokHome, grokPaths, spawnWithGrokAuth } from "../grok-home.mjs";
import { buildGrokChildEnv, resolveGrokBin } from "../grok-exec.mjs";
import { output, errorWithFailure, oneLineSummary, commandArgs } from "./base.mjs";
import { inputError } from "./session.mjs";
import { classifyFailure } from "./execution.mjs";

function parseGrokModels(text) {
  const models = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || /^(?:available models:|default model:|you are logged in|\d{4}-\d{2}-\d{2}T)/i.test(line)) {
      continue;
    }
    line = line.replace(/^(?:[-*•])\s+/, "").replace(/\s+\(default\)$/i, "");
    let columns;
    if (line.includes("|")) {
      columns = line.split("|").map((part) => part.trim()).filter(Boolean);
    } else if (/\s{2,}/.test(line)) {
      columns = line.split(/\s{2,}/);
    } else {
      columns = line.split(/\s+-\s+/, 2);
    }
    const id = columns[0];
    if (!id || /^(?:model|model id|id|name|display name)$/i.test(id) || !/^[a-z0-9][a-z0-9._\/-]*$/i.test(id)) {
      continue;
    }
    const displayName = columns[1] && !/^[-:]+$/.test(columns[1]) ? columns[1] : null;
    if (!models.has(id) || (!models.get(id).displayName && displayName)) {
      models.set(id, { id, displayName });
    }
  }
  return [...models.values()];
}

function handleModels(argv, transport = {}) {
  const { options, positionals, positionalText } = commandArgs(argv, { booleanOptions: ["json"] }, transport);
  if (positionals.length || positionalText) {
    throw inputError("The models command accepts only --json.");
  }
  const paths = grokPaths();
  ensureGrokHome(paths);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-companion-models-"));
  let result;
  try {
    result = spawnWithGrokAuth(paths, resolveGrokBin(), ["models"], { cwd: tempDir, env: { ...buildGrokChildEnv(), TMPDIR: tempDir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (result.error || result.status !== 0) {
    const diagnostic = String(result.stderr || result.stdout || result.error?.message || `Grok exited with code ${result.status ?? 1}.`).trim();
    const classified = classifyFailure({ spawnError: result.error, result: { exitCode: result.status, errorMessage: diagnostic, stderrTail: result.stderr, stdoutTail: result.stdout }, logTail: diagnostic });
    const failureKind = /unrecognized subcommand|unknown subcommand|unexpected argument.*models/i.test(diagnostic) ? "setup" : /not logged in|\b401\b/i.test(diagnostic) ? "auth" : ["missing_cli", "auth", "setup"].includes(classified) ? classified : "error";
    throw errorWithFailure(`Could not list Grok models: ${oneLineSummary(diagnostic)}`, failureKind);
  }
  const models = parseGrokModels(result.stdout);
  if (!models.length) {
    throw errorWithFailure("Could not parse the grok models listing.", "error");
  }
  output(options.json ? { engine: "grok", models, source: "grok models" } : `${models.map((model) => model.id).join("\n")}\n`, Boolean(options.json));
}

export { handleModels };
