import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildRulesManifest } from "../plugins/fusion/scripts/generate-rules-manifest.mjs";
import { DEFAULT_MODEL_TABLE_PLACEHOLDER, readModelRoutingFile, renderModelTable } from "../plugins/fusion/scripts/lib/model-table.mjs";
import { hashRulesTemplate } from "../plugins/fusion/scripts/lib/rules-template.mjs";
import { messageTag, tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { ENGINES } from "../plugins/fusion/scripts/lib/engines.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "rules-sync.mjs");
const STATIC_MODEL_CONTEXT = "This machine's capability table, breadth seat, and lane defaults arrive as session context at session start and after compaction; `/fusion:config` shows and edits them.";

const CANONICAL = `# Orchestration policy

canonical rules content

<!-- fusion:model-table:start -->
${STATIC_MODEL_CONTEXT}
<!-- fusion:model-table:end -->

canonical routing footer
`;
const OLD_VERSION = "# Orchestration policy\n\nold rules content\n";
const UNKNOWN_VERSION = "# Orchestration policy\n\nhand edited by the user\n";

function runCommand(root, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

function runGit(root, args) {
  return runCommand(root, "git", args);
}

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-rules-sync-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, "plugin");
  fs.mkdirSync(path.join(pluginRoot, "rules"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "rules", "orchestration.md"), CANONICAL, "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "rules-manifest.json"),
    `${JSON.stringify({ format: 2, hashes: [hashRulesTemplate(CANONICAL), hashRulesTemplate(OLD_VERSION)] }, null, 2)}\n`,
    "utf8"
  );
  const rulesFile = path.join(root, "live", "orchestration.md");
  const modelRoutingFile = path.join(root, "model-routing.json");
  return { root, pluginRoot, rulesFile, modelRoutingFile };
}

function run(sandbox) {
  return spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot,
      FUSION_RULES_FILE: sandbox.rulesFile,
      FUSION_MODEL_ROUTING: sandbox.modelRoutingFile
    },
    encoding: "utf8"
  });
}

function writeModelRouting(file) {
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: "2026-07-04T00:00:00.000Z",
        costProfile: "peer subscriptions flat rate",
        models: [
          { id: "codex", lane: "codex", intelligence: 5, taste: 4, cost: 5, notes: "primary implementation lane" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function runSession(sandbox, source = "startup") {
  const companion = path.join(sandbox.root, "host-check.mjs");
  fs.writeFileSync(companion, 'process.stdout.write(JSON.stringify({ blockers: [] }));');
  const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "hooks", "hooks.json"), "utf8")).hooks;
  const group = hooks.SessionStart.find((entry) => new RegExp(`^(?:${entry.matcher})$`).test(source));
  assert.ok(group, `No SessionStart hook matches ${source}.`);
  const command = group.hooks[0].command.replaceAll("${CLAUDE_PLUGIN_ROOT}", path.join(repoRoot, "plugins", "fusion"));
  return spawnSync("/bin/sh", ["-c", command], {
    env: {
      ...process.env,
      ...Object.fromEntries(Object.values(ENGINES).map((engine) => [engine.companionEnv, path.join(sandbox.root, `missing-${engine.id}.mjs`)])),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot,
      FUSION_RULES_FILE: sandbox.rulesFile,
      FUSION_MODEL_ROUTING: sandbox.modelRoutingFile,
      FUSION_DATA_DIR: path.join(sandbox.root, "data"),
      FUSION_WORKER_STATE_DIR: path.join(sandbox.root, "workers"),
      FUSION_CODEX_STATE: path.join(sandbox.root, "codex"),
      ...Object.fromEntries(Object.values(ENGINES).map((engine) => [engine.dataEnv, path.join(sandbox.root, engine.id)])),
      FUSION_GROK_COMPANION: companion
    },
    encoding: "utf8",
    timeout: 30_000
  });
}

test("Missing live file installs the canonical rules and prints the installed line", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(
    result.stdout,
    `${tagMessage("rules-sync.rules-installed", "fusion: routing rules installed (run /fusion:setup for the optional permission check)")}\n`
  );
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("Rules sync installs identical bytes for missing, scored, empty, and invalid routing data", (t) => {
  const installed = [];
  for (const state of ["missing", "scored", "empty", "invalid"]) {
    const sandbox = makeSandbox(t);
    if (state === "scored" || state === "empty") writeModelRouting(sandbox.modelRoutingFile);
    if (state === "empty") {
      const data = JSON.parse(fs.readFileSync(sandbox.modelRoutingFile, "utf8"));
      data.models = [];
      data.breadth = "devin";
      fs.writeFileSync(sandbox.modelRoutingFile, JSON.stringify(data));
    }
    if (state === "invalid") fs.writeFileSync(sandbox.modelRoutingFile, "{ invalid");
    const result = run(sandbox);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stderr, "");
    installed.push(fs.readFileSync(sandbox.rulesFile));
    assert.deepStrictEqual(installed.at(-1), Buffer.from(CANONICAL), state);
    const mtime = fs.statSync(sandbox.rulesFile).mtimeMs;
    const again = run(sandbox);
    assert.strictEqual(again.status, 0, again.stderr);
    assert.strictEqual(again.stdout, "");
    assert.strictEqual(again.stderr, "");
    assert.strictEqual(fs.statSync(sandbox.rulesFile).mtimeMs, mtime);
  }
  for (const content of installed) assert.deepStrictEqual(content, installed[0]);
});

test("Startup, clear, and compact hooks provide scored or empty routing tables and placeholders for missing or invalid data", (t) => {
  for (const state of ["missing", "scored", "empty", "invalid-json", "invalid-schema"]) {
    const sandbox = makeSandbox(t);
    if (state === "scored" || state === "empty") {
      writeModelRouting(sandbox.modelRoutingFile);
      if (state === "empty") {
        const data = JSON.parse(fs.readFileSync(sandbox.modelRoutingFile, "utf8"));
        data.models = [];
        fs.writeFileSync(sandbox.modelRoutingFile, JSON.stringify(data));
      }
    }
    if (state === "invalid-json") fs.writeFileSync(sandbox.modelRoutingFile, "{ invalid");
    if (state === "invalid-schema") fs.writeFileSync(sandbox.modelRoutingFile, JSON.stringify({ models: [] }));
    const routing = readModelRoutingFile(sandbox.modelRoutingFile);
    const expected = routing.ok ? renderModelTable(routing.data) : DEFAULT_MODEL_TABLE_PLACEHOLDER;
    for (const source of ["startup", "clear", "compact"]) {
      const result = runSession(sandbox, source);
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.strictEqual(output.hookSpecificOutput.hookEventName, "SessionStart");
      const context = output.hookSpecificOutput.additionalContext;
      assert.ok(context.endsWith(expected), `${state}, source=${source}`);
      if (source === "compact") {
        assert.strictEqual(context, `${tagMessage("session.compact-reposture", "Fusion rules are in ~/.claude/rules/orchestration.md. Collect and settle any in-flight work.")}\n${expected}`);
      } else if (source === "startup") {
        assert.ok(context.startsWith(tagMessage("rules-sync.rules-installed", "fusion: routing rules installed (run /fusion:setup for the optional permission check)")));
      } else {
        assert.strictEqual(context, expected);
      }
      if (state === "scored") {
        assert.match(context, /^\| codex \| codex \| openai \| 5 \| 4 \| 5 \| included \|$/m);
        assert.match(context, /^Breadth engine: Cursor \(cursor\)/m);
        assert.match(context, /^Lane defaults: codex quick gpt-6-sol@xhigh/m);
        assert.doesNotMatch(context, /primary implementation lane|\| Notes \|/);
      }
      if (state.startsWith("invalid")) {
        assert.match(result.stderr, /fusion: model routing file invalid/);
        assert.ok(result.stderr.trimEnd().endsWith(messageTag("rules-sync.model-table-warning")));
      } else {
        assert.strictEqual(result.stderr, "");
      }
      assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
    }
  }
});

test("The compact hook emits its tagged reminder when Node is missing", (t) => {
  const sandbox = makeSandbox(t);
  const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "hooks", "hooks.json"), "utf8")).hooks;
  const command = hooks.SessionStart.find((group) => group.matcher === "compact").hooks[0].command;
  const result = spawnSync("/bin/sh", ["-c", command], {
    env: { ...process.env, PATH: sandbox.root, CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot },
    encoding: "utf8"
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stderr, "");
  assert.strictEqual(result.stdout, `${tagMessage("session.compact-reposture", "Fusion rules are in ~/.claude/rules/orchestration.md. Collect and settle any in-flight work.")}\n`);
});

test("Compaction reloads changed scores, breadth, and lane defaults while preserving local rule edits", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const startup = runSession(sandbox);
  assert.strictEqual(startup.status, 0, startup.stderr);
  const data = JSON.parse(fs.readFileSync(sandbox.modelRoutingFile, "utf8"));
  data.models[0].intelligence = 2;
  data.models.push({ id: "muse-wonder", lane: "devin", family: "anthropic", intelligence: 5, taste: 5, cost: 3 });
  data.breadth = "devin";
  data.defaults = { codex: { quick: { model: "codex", effort: "max" } } };
  fs.writeFileSync(sandbox.modelRoutingFile, JSON.stringify(data));
  fs.writeFileSync(sandbox.rulesFile, UNKNOWN_VERSION);
  const mtime = fs.statSync(sandbox.rulesFile).mtimeMs;
  const result = runSession(sandbox, "compact");
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stderr, "");
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /^\| codex \| codex \| openai \| 2 \| 4 \| 5 \| included \|$/m);
  assert.match(context, /^\| muse-wonder \| devin \| anthropic \| 5 \| 5 \| 3 \| unknown \|$/m);
  assert.match(context, /^Breadth engine: Devin \(devin\)/m);
  assert.match(context, /^Lane defaults: codex quick codex@max/m);
  assert.doesNotMatch(context, /cursor diversity|local edits/);
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), UNKNOWN_VERSION);
  assert.strictEqual(fs.statSync(sandbox.rulesFile).mtimeMs, mtime);
});

test("Live file matching the static canonical content prints nothing and is left untouched", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, CANONICAL, "utf8");
  const before = fs.statSync(sandbox.rulesFile).mtimeMs;
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
  assert.strictEqual(fs.statSync(sandbox.rulesFile).mtimeMs, before);
});

test("session startup preserves sequential rules and breaker output", (t) => {
  for (const rules of ["missing", "unchanged", "old", "local-edits", "error"]) {
    for (const breaker of [false, true]) {
      const sandbox = makeSandbox(t);
      const companion = path.join(sandbox.root, "host-check.mjs");
      fs.writeFileSync(companion, 'process.stdout.write(JSON.stringify({ blockers: [] }));');
      const env = {
        ...process.env,
        ...Object.fromEntries(Object.values(ENGINES).map((engine) => [engine.companionEnv, path.join(sandbox.root, `missing-${engine.id}.mjs`)])),
        CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot,
        FUSION_RULES_FILE: sandbox.rulesFile,
        FUSION_MODEL_ROUTING: sandbox.modelRoutingFile,
        FUSION_WORKER_STATE_DIR: path.join(sandbox.root, "workers"),
        FUSION_DATA_DIR: path.join(sandbox.root, "data"),
        FUSION_CODEX_STATE: path.join(sandbox.root, "codex"),
        ...Object.fromEntries(Object.values(ENGINES).map((engine) => [engine.dataEnv, path.join(sandbox.root, engine.id)])),
        FUSION_GROK_COMPANION: companion,
        FUSION_BREAKER_LOOKBACK_HOURS: "12"
      };
      if (breaker) {
        const jobs = path.join(env.FUSION_CODEX_STATE, "workspace", "jobs");
        fs.mkdirSync(jobs, { recursive: true });
        fs.writeFileSync(path.join(jobs, "failure.json"), JSON.stringify({ status: "error", failureKind: "auth", finishedAt: new Date(Date.now() - 330_000).toISOString() }));
      }
      const resetRules = () => {
        fs.rmSync(path.dirname(sandbox.rulesFile), { recursive: true, force: true });
        fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
        if (rules === "unchanged") fs.writeFileSync(sandbox.rulesFile, CANONICAL);
        if (rules === "old") fs.writeFileSync(sandbox.rulesFile, OLD_VERSION);
        if (rules === "local-edits") fs.writeFileSync(sandbox.rulesFile, UNKNOWN_VERSION);
        if (rules === "error") fs.mkdirSync(sandbox.rulesFile);
      };
      const execute = (name) => {
        const result = spawnSync(process.execPath, [path.join(repoRoot, "plugins", "fusion", "scripts", `${name}.mjs`)], { env, encoding: "utf8", timeout: 30_000 });
        assert.strictEqual(result.error, undefined);
        assert.strictEqual(result.status, 0, result.stderr);
        return result;
      };
      resetRules();
      const sync = execute("rules-sync");
      const check = execute("breaker-check");
      resetRules();
      const combined = execute("session-start");
      assert.deepStrictEqual(JSON.parse(combined.stdout), {
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sync.stdout + check.stdout + DEFAULT_MODEL_TABLE_PLACEHOLDER }
      }, `${rules}, breaker=${breaker}`);
      assert.strictEqual(combined.stderr, sync.stderr + check.stderr, `${rules}, breaker=${breaker}`);
      assert.strictEqual(check.stdout.includes("breaker as open"), breaker);
      if (rules === "unchanged") assert.strictEqual(sync.stdout, "");
      else if (rules !== "error") assert.notStrictEqual(sync.stdout, "");
      if (rules === "error") assert.ok(sync.stderr.includes("rules sync failed"));
    }
  }
});

test("Live file matching a manifest hash gets overwritten and prints the updated line", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, OLD_VERSION, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, `${tagMessage("rules-sync.rules-updated", "fusion: routing rules updated to the current plugin version")}\n`);
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("An installed earlier template with a Notes table upgrades from its manifest hash", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const previous = CANONICAL
    .replace("canonical rules content", "previous shipped rules content")
    .replace(
      STATIC_MODEL_CONTEXT,
      "| Engine | Lane | Family | Intelligence | Taste | Cost | Notes |\n|---|---|---|---:|---:|---:|---|\n| codex | codex | openai | 5 | 4 | 5 | primary implementation lane |"
    );
  assert.notStrictEqual(hashRulesTemplate(previous), hashRulesTemplate(CANONICAL));
  const manifestPath = path.join(sandbox.pluginRoot, "rules-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.hashes.push(hashRulesTemplate(previous));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, previous);

  const result = run(sandbox);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, `${tagMessage("rules-sync.rules-updated", "fusion: routing rules updated to the current plugin version")}\n`);
  const updated = fs.readFileSync(sandbox.rulesFile, "utf8");
  assert.strictEqual(updated, CANONICAL);
  assert.doesNotMatch(updated, /^\| Engine \||^\| codex \||^Lane defaults:/m);
});

test("Previously shipped rules with scored or header-only tables upgrade using the committed manifest", (t) => {
  const sandbox = makeSandbox(t);
  const previous = runGit(repoRoot, ["show", "HEAD:plugins/fusion/rules/orchestration.md"]);
  const manifest = runGit(repoRoot, ["show", "HEAD:plugins/fusion/rules-manifest.json"]);
  assert.ok(JSON.parse(manifest).hashes.includes(hashRulesTemplate(previous)));
  fs.writeFileSync(path.join(sandbox.pluginRoot, "rules-manifest.json"), manifest);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  writeModelRouting(sandbox.modelRoutingFile);
  const scored = renderModelTable(readModelRoutingFile(sandbox.modelRoutingFile).data);
  const headerOnly = "| Engine | Lane | Family | Intelligence | Taste | Cost |\n|---|---|---|---:|---:|---:|";
  for (const table of [scored, headerOnly]) {
    const live = previous.replace(/<!-- fusion:model-table:start -->\n[\s\S]*?\n<!-- fusion:model-table:end -->/, `<!-- fusion:model-table:start -->\n${table}\n<!-- fusion:model-table:end -->`);
    assert.notStrictEqual(live, previous);
    assert.strictEqual(hashRulesTemplate(live), hashRulesTemplate(previous));
    fs.writeFileSync(sandbox.rulesFile, live);
    const result = run(sandbox);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, `${tagMessage("rules-sync.rules-updated", "fusion: routing rules updated to the current plugin version")}\n`);
    assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
  }
});

test("Live file with unknown content is left untouched and prints the local edits line", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, UNKNOWN_VERSION, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(
    result.stdout,
    `${tagMessage("rules-sync.local-edits-notice", `fusion: ${sandbox.rulesFile} does not match any shipped rules version (local edits), run /fusion:setup to reconcile; the live rules are preserved`)}\n`
  );
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), UNKNOWN_VERSION);
});

test("Previously rendered model scores upgrade to static rules without looking like local edits", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const rendered = CANONICAL.replace(STATIC_MODEL_CONTEXT, renderModelTable(readModelRoutingFile(sandbox.modelRoutingFile).data));
  assert.match(rendered, /^Lane defaults: codex quick gpt-6-sol@xhigh, volume gpt-6-sol@high, flagship gpt-6\.1-sol@xhigh; grok burst grok-4\.7-build-fast@low, independence grok-4\.7-build-fast@low, live-web grok-4\.7-build-fast@high, large-context grok-4\.6@medium; cursor diversity muse-spark-1\.3@xhigh \(metered\), burst composer-2\.5@default; agy independence gemini-4-neon@high, large-context gemini-4-neon@high, burst gemini-4-neon@medium; opencode bulk deepseek-v4\.1-flash@high, blind-check glm-5\.3-flash@high\.$/m);
  assert.strictEqual(hashRulesTemplate(rendered), hashRulesTemplate(CANONICAL));
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, rendered, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, `${tagMessage("rules-sync.rules-updated", "fusion: routing rules updated to the current plugin version")}\n`);
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
  assert.strictEqual(run(sandbox).stdout, "");
});

test("Changing a lane default leaves the static live rules and modification time unchanged", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const before = CANONICAL;
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, before, "utf8");
  const mtime = fs.statSync(sandbox.rulesFile).mtimeMs;
  const routing = JSON.parse(fs.readFileSync(sandbox.modelRoutingFile, "utf8"));
  routing.defaults = { codex: { quick: { model: "codex", effort: "max" } } };
  fs.writeFileSync(sandbox.modelRoutingFile, `${JSON.stringify(routing)}\n`, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, "");
  const after = fs.readFileSync(sandbox.rulesFile, "utf8");
  assert.strictEqual(after, CANONICAL);
  assert.strictEqual(fs.statSync(sandbox.rulesFile).mtimeMs, mtime);
  assert.strictEqual(hashRulesTemplate(after), hashRulesTemplate(before));
});

test("Invalid model routing does not affect rules sync or preserve a previously rendered table", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const rendered = CANONICAL.replace(STATIC_MODEL_CONTEXT, renderModelTable(readModelRoutingFile(sandbox.modelRoutingFile).data));
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, rendered, "utf8");
  fs.writeFileSync(sandbox.modelRoutingFile, "{ not json", "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, `${tagMessage("rules-sync.rules-updated", "fusion: routing rules updated to the current plugin version")}\n`);
  assert.strictEqual(result.stderr, "");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("Missing model routing upgrades a scored live table to the static template", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const rendered = CANONICAL.replace(STATIC_MODEL_CONTEXT, renderModelTable(readModelRoutingFile(sandbox.modelRoutingFile).data));
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, rendered, "utf8");
  fs.rmSync(sandbox.modelRoutingFile, { force: true });
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, `${tagMessage("rules-sync.rules-updated", "fusion: routing rules updated to the current plugin version")}\n`);
  assert.strictEqual(result.stderr, "");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("Hand edited template content still looks like local edits", (t) => {
  const sandbox = makeSandbox(t);
  const handEdited = CANONICAL.replace("canonical routing footer", "hand edited routing footer");
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, handEdited, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(
    result.stdout,
    `${tagMessage("rules-sync.local-edits-notice", `fusion: ${sandbox.rulesFile} does not match any shipped rules version (local edits), run /fusion:setup to reconcile; the live rules are preserved`)}\n`
  );
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), handEdited);
});

test("Rules sync logs unexpected failures without blocking the session", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.rulesFile, { recursive: true });
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.match(result.stderr, /^fusion: rules sync failed: /);
  assert.ok(result.stderr.trimEnd().endsWith(messageTag("rules-sync.sync-failed")));
});

test("Doctor and setup distinguish exact static rules from normalized legacy upgrades and read routing data", () => {
  const doctor = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "skills", "doctor", "SKILL.md"), "utf8");
  const setup = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "skills", "setup", "SKILL.md"), "utf8");
  assert.match(doctor, /hashRulesTemplate/);
  assert.match(doctor, /Compare the exact bytes/);
  assert.match(doctor, /model IDs in `model-routing\.json`/);
  assert.match(doctor, /show --json/);
  assert.match(setup, /hashRulesTemplate/);
  assert.match(setup, /Install these exact bytes/);
  assert.match(setup, /Previously rendered tables and older shipped templates upgrade/);
  assert.match(setup, /write the canonical content/);
  assert.match(setup, /Read capability rows from `model-routing\.json`/);
  for (const text of [doctor, setup]) assert.doesNotMatch(text, /renderRulesContent|scored canonical table|live capability table/);
});

test("background collection distinguishes explicit Fusion receipts from foreground peer delivery", () => {
  const rules = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "orchestration.md"), "utf8");
  const task = fs.readFileSync(path.join(repoRoot, "plugins", "codex", "skills", "task", "SKILL.md"), "utf8");
  const rescue = fs.readFileSync(path.join(repoRoot, "plugins", "codex", "skills", "rescue", "SKILL.md"), "utf8");
  const troubleshootingText = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8");
  assert.match(troubleshootingText, /this obligation applies to a manual receipt that crosses into the main session from a detached job launched by Fusion orchestration/);
  assert.match(troubleshootingText, /closed direct prompt containing exactly one standalone `engine: codex\|grok\|cursor\|devin\|agy` line and one standalone `job: <32 lowercase hexadecimal characters>` line/);
  assert.doesNotMatch(troubleshootingText, /`engine: codex\|grok` line/);
  assert.match(rules, /A detached receipt Fusion created is collected with `fusion:job-collector`\./);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /The lifecycle binds the collected marker to this dispatch identity\./);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /Grok, Cursor, and Devin rescue wrappers also launch their companion calls in background shells and wait through `await-output` slices; expected duration does not authorize managed detachment\./);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /Passing `run_in_background: false` does not make a dispatch synchronous/);
  assert.doesNotMatch(rules, /Managed Grok detachment is different/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /Direct Codex, Grok, Cursor, Devin, and Antigravity slash commands with explicit `--background` return manual receipts for the user to inspect and collect through their status and result commands/);
  assert.match(task, /Direct users inspect progress through `\/codex:status` and collect the deliverable through `\/codex:result`; the main session starts the receipt's per job watch through the Claude Code `Monitor` tool\./);
  assert.match(rescue, /Direct users inspect progress through `\/codex:status` and collect the deliverable through `\/codex:result`; the main session starts the receipt's per job watch through the Claude Code `Monitor` tool\./);
});

test("Grok rules document source verified headless boundaries", () => {
  const rules = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "orchestration.md"), "utf8");
  const troubleshooting = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8");
  const runtime = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "skills", "grok-cli-runtime", "SKILL.md"), "utf8");
  const doctor = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "skills", "doctor", "SKILL.md"), "utf8");
  const setup = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "skills", "setup", "SKILL.md"), "utf8");
  const stats = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "skills", "stats", "SKILL.md"), "utf8");
  const review = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "skills", "review", "SKILL.md"), "utf8");
  const contract = fs.readFileSync(path.join(repoRoot, "docs", "grok-contract.md"), "utf8");
  const codexContract = fs.readFileSync(path.join(repoRoot, "docs", "codex-contract.md"), "utf8");
  const sharedContract = fs.readFileSync(path.join(repoRoot, "docs", "companion-contract.md"), "utf8");
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const security = fs.readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
  const bridgeSentence = "The child sets all eighteen `GROK_CLAUDE_*_ENABLED`, `GROK_CURSOR_*_ENABLED`, and `GROK_CODEX_*_ENABLED` bridge variables to false; upstream currently consumes the six Claude and six Cursor cells plus the Codex sessions cell and reserves the other five Codex cells, and the child also pins `GROK_MANAGED_MCPS_ENABLED=false` because that variable has highest precedence over `[managed_mcps]` in `~/.grok/config.toml` and remote settings.";
  const hookClaim = "Grok loads hooks from plugins enabled in ~/.grok/config.toml and from ~/.grok/hooks/*.json inside managed runs, verified at 1.0.77. The GROK_CONFIG overlay does not disable them (the plugin stays loaded in GROK_HOOKS_LOG), and allow_managed_hooks_only is read only from policy layers that also bind interactive use, so /grok:setup names them and the repair is the user's [plugins] list.";
  const subagentSentence = "`--no-subagents` disables headless subagent spawning (verified on 1.0.77 and 1.0.88); the hard Agent tool deny and `GROK_SUBAGENTS=0` remain independent controls.";
  const rustLogSentence = "Every run forces `RUST_LOG=xai_grok_agent::builder=debug,xai_grok_sandbox=warn,xai_grok_shell::session::acp_session::turn=warn`.";
  const bubblewrapSentence = "On Linux, a strict profile with deny paths re-executes under bubblewrap and refuses to start when `bwrap` is missing or unusable; macOS has no equivalent hard enforcement and relies on Seatbelt application plus best-effort tool denies.";
  const freshSessionSentence = "Orchestrator cache reread cost is context size times turns, so Fusion shows the user one notice at the first prompt or dispatch past `FUSION_PARENT_CONTEXT_ADVISORY_TOKENS` context tokens. Compacting or opening a fresh session is the user's decision, and the main session never recommends either unasked.";
  const volumeTierSentence = "Research digests, review triage, doc summaries, and mechanical checks default to the codex volume lane default.";
  const volumePeerOffloadSentence = "Independent bounded packages overflow to Grok under `burst` when the Codex slot is busy.";
  const volumeRoutingDefectSentence = "Leaving the volume tiers idle while this work runs on premium lanes is a routing defect.";
  const balanceCheckSentence = "Balance check: on a delegating project, peer lanes carry a meaningful share of implementation output. A session where Claude worker lanes absorb spec grade or quick scoped packages while Codex sits idle is a routing defect.";
  const narrowWaveSentence = "Repeated width one dispatch turns on a goal with multiple independent packages are the signature of that defect, and the narrow wave watch in `/fusion:stats` surfaces it.";
  const settlementSentence = "Settlement is batched per wave: collect and verify every result in a wave, then record all verdicts in one `node <fusion plugin>/scripts/fusion-stats.mjs --record` call (the Stop hook prints the exact path and pending ids) with multiple `<id>=<accepted|rejected|unverified>` pairs, where each id is the fusion task id or the engine job id.";
  const perPackageSettlementSentence = "Per package settlement turns are reserved for waves of one.";
  const settlementInvariantSentence = "One settlement validates every pair before writing and is idempotent to rerun after a partial transport failure; it writes the worker ledger and linked engine record for every recorded verdict.";
  const settlementTransportSentence = "Record forms pass as direct arguments, including `--reason`, `--reason-for`, `--failure-kind`, and `--failure-kind-for` when every text value uses only letters, digits, spaces, and `.,:;()/_+=-`; other text uses the raw-args transport.";
  const releaseCadenceSentence = "After each release, `/fusion:stats --prune-dead` runs as part of the release cadence.";

  for (const text of [troubleshooting, runtime, contract, readme, security, doctor]) {
    assert.ok(text.includes(bridgeSentence), "Grok bridge isolation wording must stay synchronized");
  }
  for (const text of [troubleshooting, contract, readme, security, doctor]) {
    assert.ok(text.includes(hookClaim), "Grok hook behavior must stay synchronized");
  }

  for (const text of [troubleshooting, runtime, contract, readme, security]) {
    assert.ok(text.includes(subagentSentence), "Grok headless subagent wording must stay synchronized");
  }

  assert.match(rules, /strict sandbox, which is not a companion option to pass/);
  assert.doesNotMatch(rules, /use `--sandbox strict`/);
  assert.match(rules, /no silent downgrade to workspace/);
  assert.match(rules, /troubleshooting rules/);

  for (const text of [contract, troubleshooting]) {
    assert.ok(text.includes(rustLogSentence), "Grok builder tracing filter wording must stay synchronized");
  }

  for (const text of [contract, security]) {
    assert.ok(text.includes(bubblewrapSentence), "Grok platform sandbox wording must stay synchronized");
  }

  for (const text of [troubleshooting, runtime, contract]) {
    assert.match(text, /--no-subagents/);
    assert.match(text, /--disallowed-tools Agent/);
    assert.match(text, /--no-wait-for-background/);
    assert.match(text, /--prompt-file \/dev\/stdin/);
    assert.match(text, /search_tool/);
    assert.match(text, /use_tool/);
    assert.match(text, /ask_user_question/);
  }

  for (const text of [troubleshooting, runtime, contract, readme, security]) {
    assert.match(text, /--sandbox strict/);
    assert.doesNotMatch(text, /--sandbox workspace/);
    assert.match(text, /(?:never|no silent)[^\n.]*downgrade[^\n.]*workspace/i);
  }

  for (const text of [troubleshooting, runtime, contract, readme, security]) {
    assert.match(text, /ProfileApplied/);
    assert.match(text, /ApplyFailed/);
    assert.match(text, /sandbox-events\.jsonl/);
    assert.match(text, /unique private `TMPDIR`/);
    assert.match(text, /no run id or pid/);
    assert.match(text, /unrelated `ProfileApplied` and `ApplyFailed`[^\n.]*(?:not attributed|not attributable)/);
    assert.match(text, /failure (?:events|records)[^\n.]*auxiliary/i);
    assert.match(text, /(?:(?:owned-stderr|owned stderr stream)[^\n.]*warning|warning[^\n.]*(?:owned-stderr|owned stderr stream))/i);
    assert.match(text, /handshake timeout/);
    assert.match(text, /restrict_network: true/);
    assert.match(text, /macOS[^\n.]*no-op/);
    assert.match(text, /(?:Linux[^\n.]*seccomp|seccomp[^\n.]*Linux)/);
    assert.match(text, /builder tracing/);
    assert.match(text, /(?:after[^\n.]*stdin|stdin[^\n.]*after)/);
    assert.match(text, /tools allowlist applied|allowlist applied evidence|tool allowlist evidence/);
    assert.match(text, /fallback[^\n.]*unmatched|unmatched[^\n.]*fallback/i);
    assert.match(text, /--no-auto-update/);
    assert.match(text, /_GROK_CLAUDE_MARKER_OVERRIDE/);
    assert.match(text, /absolute (?:executable )?paths/);
    assert.match(text, /aliases or functions/);
    assert.match(text, /indirect scripts/);
    assert.match(text, /not (?:a )?hard[^\n.]*(?:boundary|confinement)|hard[^\n.]*boundary requires/);
    assert.match(text, /removing `run_terminal_cmd`|removing (?:that|the terminal) tool/);
    assert.match(text, /OS-level executable or network policy/);
    assert.match(text, /system_read/);
    assert.match(text, /(?:Linux[^\n.]*`\/var`[^\n.]*`\/tmp`|`\/var`[^\n.]*`\/tmp`[^\n.]*Linux)/);
    assert.match(text, /(?:macOS[^\n.]*`\/private`[^\n.]*`~\/Library`|`\/private`[^\n.]*`~\/Library`[^\n.]*macOS)/);
    assert.match(text, /shared temporary content and substantial user application configuration and caches may (?:therefore )?be readable/i);
    assert.match(text, /best-effort Read denies/);
    assert.match(text, /mcp_credentials\.json/);
    assert.match(text, /`\*\*\/\.grok`/);
    assert.match(text, /raw path variants/i);
    assert.match(text, /symbolic links/);
    assert.match(text, /shell or indirect scripts/);
    assert.match(text, /Narrower exposure (?:requires|needs) a dedicated sandbox profile, an isolated Grok home, an authentication broker, or upstream path-level authorization/);
  }

  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /Strict requests child process network restriction/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /event proves profile and configuration application, not actual platform network isolation/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /GROK_CODEX_\*_ENABLED/);
  assert.match(troubleshooting, /`search_replace` remains the write set's file-creation path/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /OpenCode-compatible `write` tool id/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /`usage_is_incomplete` means the usage ledger may have missed open subagents/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /present values are observed lower bounds/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /10000000000 ticks per USD/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /always (?:permits|include) `\/tmp` and `\/var\/tmp`/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /all of `\/private\/var\/folders`/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /not the only writable temporary surface/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /sandbox still permits consult `read_file` to reach `~\/\.grok\/auth\.json`/i);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /native MCP servers, plugins, or hooks/);
  assert.match(troubleshooting, /bridge variables gate only loose compatibility imports, not native Grok configuration/);
  for (const sentence of [
    freshSessionSentence,
    volumeTierSentence,
    volumePeerOffloadSentence,
    volumeRoutingDefectSentence,
    balanceCheckSentence,
    narrowWaveSentence,
    settlementSentence,
    perPackageSettlementSentence,
    settlementInvariantSentence,
    settlementTransportSentence,
    releaseCadenceSentence
  ]) {
    assert.ok(`${rules}\n${troubleshooting}`.includes(sentence), `Rules policy sentence must stay synchronized: ${sentence}`);
  }
  assert.match(rules, /Record accepted only when the verification command or explicit acceptance criteria pass\./);
  assert.match(rules, /literal state `uncollected`/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /one process pool per canonical cwd and sandbox profile/);
  assert.match(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8"), /agent --no-leader stdio/);
  assert.match(troubleshooting, /shared-log disappearance or rotation/);
  assert.match(troubleshooting, /sole candidate from another cwd as a fallback/);
  assert.match(troubleshooting, /Do not pass headless `--worktree` or `--worktree-ref` in a managed brief: since 1\.0\.19 they create a real worktree/);
  assert.match(runtime, /0600 file that is unlinked immediately after a successful open/);
  assert.match(runtime, /sole candidate from another cwd/);
  assert.match(runtime, /Upstream `model_usage` rows contain only `input`, `output`, `cacheRead`, and `modelCalls`/);
  assert.match(runtime, /observed lower bounds/);
  assert.match(review, /completely omits the structured output field/);
  for (const flag of [
    "--prompt-file",
    "--output-format",
    "--sandbox",
    "--tools",
    "--disallowed-tools",
    "--deny",
    "--max-turns",
    "--no-auto-update",
    "--permission-mode",
    "--allow",
    "--disable-web-search",
    "--always-approve",
    "--json-schema",
    "--no-wait-for-background"
  ]) {
    assert.match(setup, new RegExp(flag.replaceAll("-", "\\-")));
  }
  assert.match(setup, /every per-flag verdict across the plugin surface/);
  assert.match(stats, /observed input, output, cache-read, reasoning, and total token totals/);
  assert.match(stats, /`usage_is_incomplete` means the usage ledger may have missed open subagents/);
  assert.match(stats, /job-total token and cost coverage both become incomplete/);
  assert.match(contract, /`--no-leader` is mandatory because a `\[cli\] use_leader` configuration or remote setting can silently route sessions to a shared global leader process/);
  assert.match(contract, /single session-id candidate from another cwd is never a fallback/i);
  assert.match(contract, /10000000000 ticks per USD/);
  assert.match(contract, /top-level usage, cost, and flag fields are snake_case/);
  assert.match(contract, /`cache_creation_input_tokens`/);
  assert.match(contract, /The only incompleteness flags are `usage_is_incomplete` and `cost_is_partial`/);
  assert.match(contract, /no `cancellation-category` field or `model_usage_is_incomplete` field/);
  assert.match(contract, /Upstream appends to `~\/\.grok\/sessions\/sandbox-events\.jsonl` with no rotation or size cap/);
  assert.match(contract, /The open-source snapshot is per-crate versioned, unversioned as a release train with no tags/);
  assert.match(contract, /Upstream wires only `bypassPermissions` at spawn/);
  assert.match(contract, /Upstream ships ACP today/);
  assert.match(contract, /The companion has not adopted ACP yet and continues per-call invocation/);
  assert.match(codexContract, /failureKind: "setup".*below the tested minimum 0\.154\.0/);
  assert.match(codexContract, /The tested interval runs from 0\.154\.0 up to but excluding 0\.171\.0; versions below 0\.154\.0 fail task and review preflight with a setup error; versions at or above 0\.171\.0 keep running task and review preflight while `\/codex:setup` reports not ready with exit code 1 as the compatibility advisory/);
  assert.match(codexContract, /Codex configuration parse failures under `--strict-config`.*failureKind: "process"/);
  assert.match(sharedContract, /The Grok instance adds `sandbox`[^\n]*`transport`[^\n]*`policy`[^\n]*`turn_limit`[^\n]*and `network`/);
  assert.match(sharedContract, /`setup`: The installed CLI version or installation lacks a required adapter capability and fails capability preflight/);
  assert.doesNotMatch(sharedContract, /structured output that remains invalid after its corrective retry/);
  assert.match(troubleshooting, /\| setup \| Do not retry the same task against the incompatible CLI surface/);
  assert.match(rules, /`failure: setup`[^\n]*Do not retry the same task/);
  assert.match(contract, /required capability preflight failures use `setup`/);
  assert.match(runtime, /missing applicable capability fails before launch with failure kind `setup`/i);
  assert.match(runtime, /Hosted `x_search` stays outside managed runs because the fixed `--tools` allowlist governs the toolset/);
  assert.match(setup, /failure kind `setup`/);
  assert.match(doctor, /native MCP servers, plugins, or hooks under `~\/\.grok`/);
  assert.match(doctor, /The Grok home is readable under strict, but since 1\.0\.14 strict writes only `~\/\.grok\/sessions` inside it/);
  assert.match(doctor, /entire `~\/Library` on macOS/);
  assert.match(doctor, /best-effort Read denies cover `auth\.json`, `mcp_credentials\.json`/);
  assert.match(doctor, /raw path variants, symbolic links, and shell or indirect scripts can bypass/i);
  assert.match(doctor, /Bash\(grok inspect:\*\)/);
  assert.match(doctor, /Run `grok inspect --json` and review the reported `permissions`, `hooks`, `plugins`, `agents`, `mcpServers`, and `externalCompat` surfaces/);
  assert.match(doctor, /successful Grok collection remains unverified until `\/fusion:stats --record <fusion-task-id>=<accepted\|rejected>`/i);
  assert.match(doctor, /`GROK_WEB_FETCH` is pinned by web mode, `GROK_AUTO_WAKE`, `GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED`, `GROK_TURN_SUMMARY`, and `GROK_FILE_ACCELERATION` are pinned false/);
  assert.match(doctor, /`GROK_SANDBOX_MODE`, `GROK_ARTIFACTS_BIND_REMOUNT`, `GROK_FILE_ACCELERATION_ROUTES`, `GROK_CURSOR_WORKER_API_BASE`, and `GROK_CURSOR_WORKER_COMMAND` are removed/);
  for (const text of [readme, security]) {
    assert.match(text, /introduced in 0\.2\.112, verified through 1\.0\.41/);
    assert.match(text, /file that is unlinked (?:immediately after open|as soon as it is opened)/);
    assert.match(text, /all of `\/private\/var\/folders`/);
    assert.match(text, /native MCP servers, plugins, or hooks/);
    assert.match(text, /Narrower exposure requires a dedicated sandbox profile, an isolated Grok home, an authentication broker, or upstream path-level authorization/);
    assert.doesNotMatch(text, /Native Grok hooks have no single headless disable flag/);
  }
});

test("The shipped rules manifest contains the current rules file template hash", () => {
  const rulesPath = path.join(repoRoot, "plugins", "fusion", "rules", "orchestration.md");
  const manifestPath = path.join(repoRoot, "plugins", "fusion", "rules-manifest.json");
  const canonical = fs.readFileSync(rulesPath, "utf8");
  const currentHash = hashRulesTemplate(canonical);
  assert.strictEqual(canonical.split("<!-- fusion:model-table:start -->\n")[1].split("\n<!-- fusion:model-table:end -->")[0], STATIC_MODEL_CONTEXT);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.strictEqual(manifest.format, 2);
  assert.ok(
    manifest.hashes.includes(currentHash),
    "plugins/fusion/rules-manifest.json is stale, run node plugins/fusion/scripts/generate-rules-manifest.mjs"
  );
  const previous = JSON.parse(runGit(repoRoot, ["show", "HEAD:plugins/fusion/rules-manifest.json"]));
  for (const hash of previous.hashes) assert.ok(manifest.hashes.includes(hash), `missing previously shipped hash ${hash}`);
});

test("Rules manifest generator hashes only HEAD history and working tree content", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-rules-manifest-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relativeRulesPath = path.join("plugins", "fusion", "rules", "orchestration.md");
  const rulesPath = path.join(root, relativeRulesPath);
  const mainContent = "# Orchestration policy\n\nmain branch release\n";
  const branchOnlyContent = "# Orchestration policy\n\nnon-main branch only\n";
  const workingTreeContent = "# Orchestration policy\n\ncurrent working tree\n";
  const signingKey = path.join(root, "fixture-signing-key");

  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  runCommand(root, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", signingKey]);
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Fusion Test"]);
  runGit(root, ["config", "user.email", "fusion-test@example.com"]);
  runGit(root, ["config", "gpg.format", "ssh"]);
  runGit(root, ["config", "gpg.ssh.program", "ssh-keygen"]);
  runGit(root, ["config", "user.signingkey", signingKey]);
  runGit(root, ["config", "commit.gpgsign", "true"]);
  fs.writeFileSync(rulesPath, mainContent, "utf8");
  runGit(root, ["add", relativeRulesPath]);
  runGit(root, ["commit", "-m", "main release"]);
  runGit(root, ["switch", "-c", "unreleased-side-branch"]);
  fs.writeFileSync(rulesPath, branchOnlyContent, "utf8");
  runGit(root, ["add", relativeRulesPath]);
  runGit(root, ["commit", "-m", "unreleased side branch"]);
  runGit(root, ["switch", "main"]);
  fs.writeFileSync(rulesPath, workingTreeContent, "utf8");

  const manifest = buildRulesManifest({ root, relativeRulesPath });

  assert.deepStrictEqual(manifest, {
    format: 2,
    hashes: [hashRulesTemplate(mainContent), hashRulesTemplate(workingTreeContent)].sort()
  });
  assert.ok(!manifest.hashes.includes(hashRulesTemplate(branchOnlyContent)));
});
