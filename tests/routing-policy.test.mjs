import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");

function readRepoFile(file) {
  return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

function frontmatterValue(content, field) {
  const match = content.match(new RegExp(`^${field}: (.+)$`, "m"));
  assert.ok(match, `missing ${field} frontmatter`);
  return match[1];
}

function protectedRoles(content, pattern) {
  const match = content.match(pattern);
  assert.ok(match, "missing protected Grok role declaration");
  return [...match[1].matchAll(/`([^`]+)`/g)].map((entry) => entry[1]);
}

const rules = readRepoFile("plugins/fusion/rules/orchestration.md");
const troubleshooting = readRepoFile("plugins/fusion/rules/troubleshooting.md");
const deepReasoner = readRepoFile("plugins/fusion/agents/deep-reasoner.md");
const fastWorker = readRepoFile("plugins/fusion/agents/fast-worker.md");
const trivialWorker = readRepoFile("plugins/fusion/agents/trivial-worker.md");
const ultra = readRepoFile("plugins/fusion/skills/ultra/SKILL.md");
const panel = readRepoFile("plugins/fusion/skills/panel/SKILL.md");
const codexRescue = readRepoFile("plugins/codex/agents/codex-rescue.md");
const grokRescue = readRepoFile("plugins/grok/agents/grok-rescue.md");
const grokReviewRunner = readRepoFile("plugins/grok/agents/grok-review-runner.md");
const readme = readRepoFile("README.md");

test("the main Claude session remains the sole control plane", () => {
  assert.match(
    rules,
    /The main session owns ambiguity resolution, decomposition, integration, semantic acceptance, final judgment, and user communication\./
  );
  assert.match(rules, /It may perform one bounded micro step and read only verification, but it never executes a work package\./);
  assert.match(rules, /Explore owns open ended read only repository reconnaissance\./);
  assert.match(
    rules,
    /The built in Plan agent has no automatic routing seat: routine planning stays in the main session, and high stakes decisions use the panel\./
  );
  assert.match(rules, /Judging results, reconciling disagreement, revising the plan, semantic acceptance, user communication \| main loop/);
  assert.match(readme, /sole control plane: resolve ambiguity, decompose, integrate, verify, record semantic acceptance, make the final judgment, and communicate with the user; it does not execute work packages/);
});

test("Claude workers stay inside their advisory and fallback roles", () => {
  assert.match(deepReasoner, /Read only advisory lane/);
  assert.match(deepReasoner, /It recommends and challenges; the main session decides, implements through another lane, and owns acceptance\./);
  assert.match(deepReasoner, /Never edit files, execute an implementation brief, dispatch another agent, or claim final acceptance\./);
  assert.match(deepReasoner, /If the brief needs broader reconnaissance, return that gap to the main session\./);
  assert.equal(frontmatterValue(deepReasoner, "tools"), "Read, Grep, Glob");
  assert.equal(frontmatterValue(deepReasoner, "background"), "false");

  assert.match(fastWorker, /Claude execution fallback/);
  assert.match(fastWorker, /resolved implementation briefs that require the Claude Code tool surface/);
  assert.match(fastWorker, /remain inside the Claude privacy boundary/);
  assert.match(fastWorker, /Every brief includes a verification command/);
  assert.equal(frontmatterValue(fastWorker, "disallowedTools"), "Agent");
  assert.equal(frontmatterValue(fastWorker, "background"), "false");

  assert.match(trivialWorker, /Fallback tier only for exact, low risk, tiny packages/);
  assert.match(trivialWorker, /when no eligible peer lane is available or Claude-only tools or privacy are required/);
  assert.match(trivialWorker, /Change briefs include a verification command; analysis, drafting, and research briefs include explicit acceptance criteria\./);
  assert.match(trivialWorker, /For a change brief, run its verification command/);
  assert.match(trivialWorker, /For an analysis, drafting, or research brief, check the result against its explicit acceptance criteria/);
  assert.equal(frontmatterValue(trivialWorker, "disallowedTools"), "Agent");
  assert.equal(frontmatterValue(trivialWorker, "background"), "false");

  assert.match(troubleshooting, /`fusion:deep-reasoner` is a read only advisory lane and never receives an implementation brief as an execution retry/);
  assert.doesNotMatch(troubleshooting, /fusion:trivial-worker to fusion:fast-worker to fusion:deep-reasoner/);
});

test("Codex admission preserves primary ownership before overflow", () => {
  assert.match(rules, /Codex is the primary implementation lane and the default deep external reviewer\./);
  assert.match(
    rules,
    /Codex admission follows one ladder: use the current workspace when its Codex slot is free; otherwise use an isolated Codex worktree for an independent, worktree eligible package; otherwise route an independent package that fits Grok's safety and turn boundaries under the `burst` role; otherwise use the matching Claude fallback\./
  );
  assert.match(rules, /Worktree eligible means disjoint files and verification that needs no heavy dependency setup\./);
  assert.match(rules, /Dispatch a Codex implementation package there by using `--write --cwd "<absolute worktree path>" -- <brief>` as the complete direct prompt to `codex:codex-rescue`\./);
  assert.match(rules, /never append `--cwd` to the rescue Agent call, its Bash command, or the `--raw-args-token` invocation\./);
  assert.match(rules, /A natural language `Working directory:` line is context only and does not select the Codex sandbox\./);
  assert.match(
    rules,
    /Packages that overlap files, share generated state, require ordering, or cannot be merged independently never overflow in parallel merely by changing engines; consolidate or sequence them\./
  );
  assert.match(rules, /Capability scores never change lane ownership by themselves\./i);
  assert.match(readme, /Codex is the primary implementation lane and default deep external reviewer\./);
  assert.match(
    readme,
    /Codex first admission follows this order: use Codex in the current workspace, then an isolated Codex worktree for an independent eligible package, then Grok under `burst` for an independent package inside its safety and turn boundaries, then the matching Claude fallback\./
  );
  assert.equal(frontmatterValue(codexRescue, "background"), "false");
});

test("Grok automatic routing exposes four protected roles while the companion retains legacy support", () => {
  const expected = ["burst", "independence", "live-web", "large-context"];
  const legacyExpected = [...expected];
  assert.deepEqual(protectedRoles(rules, /four protected routing roles: (.+?)\. Grok remains/), expected);
  assert.deepEqual(protectedRoles(grokRescue, /Automatic Fusion routing must name one protected role: (.+?)\./), legacyExpected);
  assert.match(rules, /The single header line for every automatically routed Grok brief includes `grok-role: <role>`/);
  assert.match(rules, /where `<role>` is exactly one of `burst`, `independence`, `live-web`, or `large-context`/);
  assert.match(rules, /a direct `\/grok:\*` command or explicit user request for Grok is a user selected override and does not need that field/);
  assert.match(rules, /it is not a generic alternative merely because it is idle or fast/);
  assert.match(grokRescue, /Do not take ordinary implementation merely because Grok is idle, fast, or bills to xAI\./);
  assert.match(grokRescue, /Do not grab simple read only answers or diagnoses that the main Claude thread can finish quickly on its own\./);
  assert.match(grokRescue, /Requested changes still follow the Codex first admission ladder unless a protected Grok role applies\./);
  assert.match(grokRescue, /text output contains terminal `state` and `failure` footer lines \(plus `job` when a record was created\), or JSON output contains top level `status` and `failureKind` fields/);
  assert.match(grokRescue, /only when Node or the companion cannot be invoked and no valid typed text or JSON outcome exists/);
  assert.match(grokRescue, /Never use Bash background mode\./);
  assert.match(grokRescue, /An explicit incoming user `--background` stays inside the raw request\./);
  assert.match(grokReviewRunner, /return an output containing `phase: cleanup-required` instead of chaining/);
  assert.match(grokReviewRunner, /top level `status` is `running`, and `cleanupRequired` is not true/);
  assert.match(readme, /Grok is a complementary specialist and burst lane with four protected roles/);
  assert.equal(frontmatterValue(grokRescue, "background"), "false");
});

test("Ultra expands capacity without changing lane ownership", () => {
  assert.match(ultra, /Return it to the normal routing policy: questions stay in the main session, and requested changes normally use the Codex primary lane\./);
  assert.match(ultra, /The fleet changes capacity, not lane ownership\. Codex remains the primary builder and deep reviewer\./);
  for (const role of ["burst", "live-web", "large-context", "independence"]) {
    assert.ok(ultra.includes(`\`${role}\``), `Ultra must preserve the ${role} Grok role`);
  }
  assert.match(ultra, /Every Grok facet brief begins with a single routing header line containing exactly one `grok-role: <role>` field/);
  assert.match(ultra, /choosing one of `burst`, `independence`, `live-web`, or `large-context` from the facet's actual purpose/);
  assert.match(ultra, /Do not include a second Grok role anywhere in that brief\./);
  assert.match(ultra, /Additional independent Codex implementation facets may use distinct orchestrator owned worktrees when their files are disjoint and verification needs no heavy setup\./);
  assert.match(ultra, /For each such facet, use `--write --cwd "<absolute worktree path>" -- <brief>` as the complete direct prompt to `codex:codex-rescue`\./);
  assert.match(ultra, /`--cwd` must never be appended to the Agent call, wrapper Bash command, or `--raw-args-token` invocation\./);
  assert.match(ultra, /Packages that overlap files or require ordering are consolidated or sequenced, never fanned out as parallel overflow\./);
  assert.match(ultra, /Never set background mode on the Codex Agent or add `--background` to its brief\./);
  assert.match(ultra, /a final verification pass \(typecheck and tests\) run once over the combined result/);
  assert.ok(
    frontmatterValue(ultra, "allowed-tools")
      .split(",")
      .map((tool) => tool.trim())
      .includes("Bash"),
    "Ultra needs Bash to run its promised combined verification"
  );
});

test("the panel stays blind, asymmetric, evidence weighted, and main judged", () => {
  assert.match(panel, /In the standard external panel, every engine receives the same neutral brief, works with no knowledge of the other panelists/);
  assert.match(panel, /Never include a candidate answer, a leaning, any prior model opinion, or any context from this conversation\./);
  assert.match(panel, /Its first line is the single routing header required by policy and includes `lane: panel`, `grok-role: independence` \(one of the four permitted Grok roles\), and the explicit acceptance criteria/);
  assert.match(panel, /invoke `grok:grok-rescue` and `codex:codex-rescue` with the identical brief as their direct prompt/);
  assert.match(panel, /Do not set `run_in_background`; parallel tool calls provide overlap while each result remains owned and collected/);
  assert.match(panel, /A panel never runs with fewer than two tracks\./);
  assert.match(panel, /This is the only exception to the identical brief rule\./);
  assert.match(panel, /Keep the exact brief in the Agent calls and pass it directly as each Agent prompt\./);
  assert.match(panel, /Panel consultations do not use isolated implementation worktrees or a Codex only `--cwd` prefix because either would violate the identical brief invariant\./);
  assert.match(panel, /Never average the verdicts or count them as equal votes\./);
  assert.match(panel, /configured Codex frontier lane is the default deep lead on long horizon correctness and architecture/);
  assert.match(panel, /configured Grok lane is an independent cross check weighted on large context factual verification and terminal or operational pragmatics/);
  assert.match(panel, /stronger concrete evidence wins a disputed point regardless of which engine produced it/);
  assert.match(panel, /Disagreement triggers exactly ONE targeted follow up to ONE engine on the specific point of disagreement; never run a second full fan out\./);

  assert.match(rules, /These are evidence weighted lane priors: stronger concrete evidence wins a disputed point regardless of its engine\./);
  assert.match(rules, /Verdicts are never averaged and never counted as equal votes\./);
  assert.match(rules, /The main session remains the final judge and attributes every claim to its engine\./);
});
