import { parseArgs } from "./shared-args.mjs";

export { parseArgs, parseRawArgs, splitRawArgumentString } from "./shared-args.mjs";

const SERVICE_TIER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function parseServiceTier(value) {
  if (value == null) {
    return "priority";
  }
  if (value === "none") {
    return null;
  }
  if (typeof value !== "string" || !SERVICE_TIER_PATTERN.test(value)) {
    throw Object.assign(new TypeError("The --service-tier option must be a lowercase id or none."), { failureKind: "input" });
  }
  return value;
}

const RECORD_ACCEPTANCE_JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const RECORD_ACCEPTANCE_VALUES = new Set(["accepted", "rejected", "unverified"]);
const RECORD_ACCEPTANCE_SOURCES = new Set(["collector", "main-loop", "stats"]);
const SEMANTIC_FAILURE_KINDS = new Set(["intent_override", "scope_rewrite", "wrong_approach", "style_mismatch", "oversized"]);

function inputError(message) {
  return Object.assign(new Error(message), { failureKind: "input" });
}

export function parseRecordAcceptanceArgs(argv) {
  const names = { "--job-id": "jobId", "--acceptance": "acceptance", "--reason": "reason", "--failure-kind": "failureKind", "--source": "source", "--accept-failed-transport": "acceptFailedTransport", "--json": "json" };
  const booleanOptions = ["acceptFailedTransport", "json"];
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const key = Object.hasOwn(names, token) ? names[token] : null;
    if (!key) throw inputError("The record-acceptance command accepts only --job-id, --acceptance, --reason, --failure-kind, --source, --accept-failed-transport, and --json.");
    if (seen.has(key)) throw inputError(booleanOptions.includes(key) ? `The ${token} option may be provided only once.` : `${token} may be provided only once.`);
    seen.add(key);
    if (booleanOptions.includes(key)) normalized.push(token);
    else {
      const value = argv[++index];
      if (value === undefined) throw inputError(`${token} requires a value.`);
      normalized.push(`${token}="${value}"`);
    }
  }
  const { options } = parseArgs(normalized, {
    valueOptions: ["jobId", "acceptance", "reason", "failureKind", "source"], booleanOptions,
    aliasMap: Object.fromEntries(Object.entries(names).map(([token, key]) => [token.slice(2), key]))
  });
  if (!RECORD_ACCEPTANCE_JOB_ID_PATTERN.test(options.jobId ?? "")) {
    throw inputError("The --job-id option must be a 32 character lowercase hexadecimal job id.");
  }
  if (!RECORD_ACCEPTANCE_VALUES.has(options.acceptance)) {
    throw inputError("The --acceptance option must be accepted, rejected, or unverified.");
  }
  if (options.failureKind !== undefined && !SEMANTIC_FAILURE_KINDS.has(options.failureKind)) {
    throw inputError("The --failure-kind option must be intent_override, scope_rewrite, wrong_approach, style_mismatch, or oversized.");
  }
  if (options.failureKind !== undefined && options.acceptance !== "rejected") {
    throw inputError("The --failure-kind option is valid only with --acceptance rejected.");
  }
  if (options.acceptance === "rejected" && !options.reason?.trim()) {
    throw inputError("A rejected acceptance requires --reason.");
  }
  options.source ??= "stats";
  if (!RECORD_ACCEPTANCE_SOURCES.has(options.source)) {
    throw inputError("The --source option must be collector, main-loop, or stats.");
  }
  return options;
}
