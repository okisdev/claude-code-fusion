import { createHash } from "node:crypto";

const CODE_MIN = 1000;
const CODE_SPAN = 9000;

const MESSAGE_REGISTRY = [
  { slug: "inline-guard.write-budget-advisory", description: "Strict posture advisory naming inline write count and available lanes." },
  { slug: "inline-guard.unverified-advisory", description: "Judgment posture advisory counting unverified writes in the current window." },
  { slug: "inline-guard.write-budget-deny", description: "Strict posture denial of a main loop write past the budget." },
  { slug: "inline-guard.tail-allowance-advisory", description: "Strict posture relief permitting a small Edit to an already touched file." },
  { slug: "inline-guard.zero-dispatch-advisory", description: "Strict posture relief for a window that has not dispatched yet." },
  { slug: "inline-guard.no-op-heartbeat-deny", description: "Denial of a no-op Bash command while Fusion tasks are in flight." },
  { slug: "inline-guard.reaped-worker-redirect", description: "Denial of a TaskOutput or TaskStop probe of a reaped worker with the result path." },
  { slug: "inline-guard.narrow-wave-advisory", description: "Advisory after consecutive width one dispatch waves." },
  { slug: "inline-guard.state-unavailable-deny", description: "Strict posture fail closed denial when guard state is unreadable." },
  { slug: "inline-guard.allow-retired-notice", description: "Notice that the allow escape hatch subcommand is retired." },
  { slug: "worker-lifecycle.foreground-wrapper-deny", description: "Denial of background delivery for a peer wrapper Agent." },
  { slug: "worker-lifecycle.collector-request-deny", description: "Denial of a collector request missing its engine and job lines." },
  { slug: "worker-lifecycle.brief-validation-deny", description: "Denial of a worker brief that fails envelope validation." },
  { slug: "worker-lifecycle.background-authorization-deny", description: "Denial of background execution without explicit user authorization." },
  { slug: "worker-lifecycle.dispatch-advisory", description: "Dispatch time advisory on verification suites, sizing, or transcript size." },
  { slug: "worker-lifecycle.final-deliverable-allow", description: "Permission for a stopping worker's final deliverable write." },
  { slug: "worker-lifecycle.worker-stop-deny", description: "Instruction that a stopping worker must return a concise partial result." },
  { slug: "worker-lifecycle.budget-wind-down", description: "Wind down instruction as a worker approaches its token or turn budget." },
  { slug: "worker-lifecycle.subagent-start-context", description: "Start of worker context naming task id, budgets, and delivery contract." },
  { slug: "worker-lifecycle.collector-marker-block", description: "Block of a collector whose completion marker is invalid." },
  { slug: "worker-lifecycle.deliverable-retry-block", description: "Retry instruction for a worker that stopped without a deliverable." },
  { slug: "worker-lifecycle.collector-reporting-block", description: "Stop block until collector failures are reported with ids and commands." },
  { slug: "worker-lifecycle.semantic-judgment-block", description: "Stop block until collected peer results receive semantic judgment." },
  { slug: "worker-lifecycle.acceptance-advisory", description: "Stop advisory that acceptance is unverified with the settlement command." },
  { slug: "worker-lifecycle.acceptance-required-block", description: "Stop block until collected results are explicitly accepted or rejected." },
  { slug: "worker-lifecycle.terminal-collection-block", description: "Stop block until terminal task results are collected from their files." },
  { slug: "worker-lifecycle.wrapper-death-context", description: "Notice that a wrapper died before delivery with redispatch guidance." },
  { slug: "worker-lifecycle.over-budget-stop-block", description: "Stop block requiring TaskStop for tasks past their lifecycle budget." },
  { slug: "worker-lifecycle.pre-runtime-failure-block", description: "Stop block reporting tasks that failed before a runtime id existed." },
  { slug: "worker-lifecycle.task-reaped-context", description: "Notice that harness reaped tasks were settled as task_reaped." },
  { slug: "worker-lifecycle.in-flight-context", description: "Notice that tasks are still in flight with collection armed." },
  { slug: "worker-lifecycle.state-unavailable", description: "Fail closed denial or block when lifecycle state is unreadable." },
  { slug: "fleet-posture.strict-fleet-reminder", description: "Strict posture prompt reminder of the fleet default." },
  { slug: "fleet-posture.session-lanes-reminder", description: "Once per session judgment posture reminder of lane availability and the fan out default." },
  { slug: "fleet-posture.narrow-wave-reminder", description: "Prompt reminder after consecutive width one dispatch waves." },
  { slug: "breaker-check.breaker-advisory", description: "Session start advisory that an engine circuit breaker is open." },
  { slug: "rules-sync.sync-failed", description: "Session start error that rules sync failed." },
  { slug: "rules-sync.rules-installed", description: "Session start notice that routing rules were installed." },
  { slug: "rules-sync.rules-updated", description: "Session start notice that routing rules were updated to this version." },
  { slug: "rules-sync.local-edits-notice", description: "Session start notice that the live rules file has local edits." },
  { slug: "rules-sync.model-table-warning", description: "Warning that the model routing table could not be rendered." },
  { slug: "session.compact-reposture", description: "Post compaction instruction to restate posture and recheck dispatch tracking." },
  { slug: "codex-monitor.job-notification", description: "Monitor line reporting a detached Codex job transition or observation." },
  { slug: "stats.raw-args-required", description: "Stats error that free text arguments must ride the raw args transport." }
];

const CODE_BY_SLUG = new Map(
  MESSAGE_REGISTRY.map((entry) => [entry.slug, deriveCode(entry.slug)])
);

function deriveCode(slug) {
  const digest = createHash("sha256").update(slug).digest();
  return CODE_MIN + (digest.readUInt32BE(0) % CODE_SPAN);
}

function messageCode(slug) {
  const code = CODE_BY_SLUG.get(slug);
  if (code === undefined) {
    throw new RangeError(`Unknown fusion message slug: ${slug}`);
  }
  return code;
}

function messageTag(slug) {
  return `[fusion:${messageCode(slug)}]`;
}

function tagMessage(slug, text) {
  return `${text} ${messageTag(slug)}`;
}

function registryEntry(code) {
  for (const entry of MESSAGE_REGISTRY) {
    if (CODE_BY_SLUG.get(entry.slug) === code) {
      return { ...entry, code };
    }
  }
  return null;
}

export { MESSAGE_REGISTRY, messageCode, messageTag, registryEntry, tagMessage };
