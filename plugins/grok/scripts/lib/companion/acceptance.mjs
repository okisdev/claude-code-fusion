import { renderRecordAcceptance } from "../render.mjs";
import { findJobRecordById, nowIso, resolveDataDir, updateJobRecordFileWithCurrent } from "../state.mjs";
import { RECORD_ACCEPTANCE_JOB_ID_PATTERN, RECORD_ACCEPTANCE_SOURCES, RECORD_ACCEPTANCE_VALUES, SEMANTIC_FAILURE_KINDS } from "./config.mjs";
import { output, errorWithFailure } from "./base.mjs";

function recordAcceptanceArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--accept-failed-transport" || token === "--json") {
      const flag = token === "--json" ? "json" : "acceptFailedTransport";
      if (options[flag]) {
        throw errorWithFailure(`The ${token} option may be provided only once.`, "input");
      }
      options[flag] = true;
      continue;
    }
    const key = token === "--job-id" ? "jobId" : token === "--acceptance" ? "acceptance" : token === "--reason" ? "reason" : token === "--failure-kind" ? "failureKind" : token === "--source" ? "source" : null;
    if (!key) {
      throw errorWithFailure("The record-acceptance command accepts only --job-id, --acceptance, --reason, --failure-kind, --source, --accept-failed-transport, and --json.", "input");
    }
    if (Object.hasOwn(options, key)) {
      throw errorWithFailure(`${token} may be provided only once.`, "input");
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw errorWithFailure(`${token} requires a value.`, "input");
    }
    options[key] = value;
    index += 1;
  }
  if (!RECORD_ACCEPTANCE_JOB_ID_PATTERN.test(options.jobId ?? "")) {
    throw errorWithFailure("The --job-id option must be a 32 character lowercase hexadecimal job id.", "input");
  }
  if (!RECORD_ACCEPTANCE_VALUES.has(options.acceptance)) {
    throw errorWithFailure("The --acceptance option must be accepted, rejected, or unverified.", "input");
  }
  if (options.failureKind !== undefined && !SEMANTIC_FAILURE_KINDS.has(options.failureKind)) {
    throw errorWithFailure("The --failure-kind option must be intent_override, scope_rewrite, wrong_approach, style_mismatch, or oversized.", "input");
  }
  if (options.failureKind !== undefined && options.acceptance !== "rejected") {
    throw errorWithFailure("The --failure-kind option is valid only with --acceptance rejected.", "input");
  }
  if (options.acceptance === "rejected" && !options.reason?.trim()) {
    throw errorWithFailure("A rejected acceptance requires --reason.", "input");
  }
  options.source ??= "stats";
  if (!RECORD_ACCEPTANCE_SOURCES.has(options.source)) {
    throw errorWithFailure("The --source option must be collector, main-loop, or stats.", "input");
  }
  return options;
}

function handleRecordAcceptance(argv) {
  const { acceptance, acceptFailedTransport, failureKind, jobId, json, reason, source } = recordAcceptanceArgs(argv);
  const found = findJobRecordById(resolveDataDir(), jobId);
  if (!found) {
    throw errorWithFailure(`No job record found for ${jobId}.`, "input");
  }
  const record = updateJobRecordFileWithCurrent(found.file, (current) => {
    if (acceptance === "accepted" && current.status !== "done" && !acceptFailedTransport) {
      throw errorWithFailure(
        `Grok job ${current.id} has transport status ${current.status}. Pass --accept-failed-transport to record accepted.`,
        "input"
      );
    }
    if (acceptance !== "rejected") {
      return {
        ...current,
        acceptanceRecordedAt: nowIso(),
        acceptanceSource: source,
        semanticFailureKind: null,
        semanticFailureMessage: null,
        semanticStatus: acceptance
      };
    }
    return {
      ...current,
      acceptanceRecordedAt: nowIso(),
      acceptanceSource: source,
      semanticFailureKind: failureKind ?? null,
      semanticFailureMessage: reason,
      semanticStatus: acceptance
    };
  }, { allowTerminal: true });
  if (json) {
    output({ id: record.id, semanticStatus: record.semanticStatus, semanticFailureKind: record.semanticFailureKind ?? null, acceptanceSource: record.acceptanceSource ?? null }, true);
    return;
  }
  output(renderRecordAcceptance(record), false);
}

export { handleRecordAcceptance };
