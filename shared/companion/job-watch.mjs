import { fileURLToPath } from "node:url";

const MONITOR_MAX_MS = 30 * 60 * 1000;
const WATCH_MAX_MS = 29 * 60 * 1000;
const DEADLINE_GRACE_MS = 15000;

function duration(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function backgroundBudgetMs(engine, env) {
  const prefix = `${engine.toUpperCase()}_COMPANION_`;
  const configured = duration(env, `${prefix}${engine === "codex" ? "BACKGROUND_TIMEOUT_MS" : "TIMEOUT_MS"}`, ["codex", "grok"].includes(engine) ? MONITOR_MAX_MS : 540000);
  return engine === "grok" ? Math.min(configured, MONITOR_MAX_MS) : configured;
}

export function backgroundWatchReceipt(engine, jobId, env = process.env) {
  const companion = fileURLToPath(new URL(`../${engine}-companion.mjs`, import.meta.url));
  const quoted = companion.replace(/[\\"$`]/g, "\\$&");
  const watchCommand = `node "${quoted}" watch --job ${jobId}`;
  const watchDurationSeconds = Math.min(Math.ceil(backgroundBudgetMs(engine, env) / 1000) + 60, MONITOR_MAX_MS / 1000);
  return {
    watchCommand,
    watchDurationSeconds,
    watchInstruction: `The main session must start one Claude Code Monitor tool watch with a duration of ${watchDurationSeconds} seconds (the engine background budget plus 60 seconds, capped at 30 minutes) and command: ${watchCommand}. The watch completion line is the cue to collect with /${engine}:result ${jobId}. If a Monitor deadline notice arrives before the completion line, re-arm the same watch command with the same duration. A still running line also requires re-arming the same watch command.`
  };
}

export async function watchJob(argv, { engine, readJob, env = process.env }) {
  if (argv.length !== 2 || argv[0] !== "--job" || !/^[a-f0-9]{32}$/.test(argv[1])) {
    throw new Error("watch requires --job followed by a 32 character lowercase hexadecimal job id.");
  }
  const jobId = argv[1];
  const prefix = `${engine.toUpperCase()}_COMPANION_`;
  const pollMs = duration(env, `${prefix}WATCH_POLL_MS`, 15000);
  const watchDeadline = Date.now() + Math.min(duration(env, `${prefix}WATCH_MAX_MS`, WATCH_MAX_MS), WATCH_MAX_MS);
  for (;;) {
    const record = await readJob(jobId);
    if (!record) throw new Error(`No job record found for ${jobId}.`);
    const failure = record.failureKind ? ` (${String(record.failureKind).replace(/\s+/g, " ")})` : "";
    const recordedDeadline = Date.parse(record.deadlineAt ?? "");
    const deadline = Number.isFinite(recordedDeadline) ? recordedDeadline
      : Date.parse(record.startedAt ?? record.createdAt ?? "") + (record.timeoutMs ?? backgroundBudgetMs(engine, env));
    const expired = Date.now() > deadline + DEADLINE_GRACE_MS;
    const cleanupRequired = record.cleanupRequired || record.phase === "cleanup-required" || (record.status === "running" && expired);
    const orphaned = record.failureKind === "died" || (record.status === "error" && record.failureKind === "timeout" && expired);
    if (cleanupRequired || orphaned) {
      process.stdout.write(`${engine} job ${jobId} ${cleanupRequired ? "cleanup required" : "orphaned"}${failure}. inspect with /${engine}:result ${jobId}; cancel with /${engine}:cancel ${jobId}; completion notices do not replace collection.\n`);
      return;
    }
    if (["done", "error", "cancelled"].includes(record.status)) {
      process.stdout.write(`${engine} job ${jobId} ${record.status}${failure}. collect with /${engine}:result ${jobId}; completion notices do not replace collection.\n`);
      return;
    }
    if (Date.now() >= watchDeadline) {
      process.stdout.write(`${engine} job ${jobId} still running. re-arm the same watch command with the receipt's Monitor duration; inspect with /${engine}:result ${jobId}.\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, watchDeadline - Date.now()))));
  }
}
