import fs from "node:fs";
import { listAuditSegments as listGuardAuditSegments, resolveAuditDir as resolveGuardAuditDir } from "../../inline-delegation-guard.mjs";
import { MESSAGE_REGISTRY, messageCode } from "../../lib/user-messages.mjs";
import { ENGINE_JOB_ID_PATTERN, FUSION_TASK_ID_PATTERN, RECORD_SOURCES, RECORD_VERDICTS, SEMANTIC_FAILURE_KINDS } from "./evidence.mjs";

export function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const value = argv[index + 1];
  return typeof value === "string" && value && !value.startsWith("--") ? value : null;
}

export function isIntegerToken(value) {
  return typeof value === "string" && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value));
}

function messageEntryHeader(entry) {
  return `[fusion:${entry.code}] ${entry.slug} - ${entry.description}`;
}

export function renderMessageRegistry() {
  const entries = MESSAGE_REGISTRY
    .map((entry) => ({ ...entry, code: messageCode(entry.slug) }))
    .sort((left, right) => left.code - right.code || left.slug.localeCompare(right.slug));
  return `${entries.map(messageEntryHeader).join("\n")}\n`;
}

export function readMessageOccurrences(code, env) {
  const occurrences = [];
  let order = 0;
  try {
    const segments = listGuardAuditSegments(resolveGuardAuditDir(env)).sort((left, right) => left.date.localeCompare(right.date) || left.index - right.index);
    for (const segment of segments) {
      let text;
      try {
        text = fs.readFileSync(segment.file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          const event = JSON.parse(line);
          const atMs = Date.parse(event?.at ?? "");
          if (Number.isInteger(event?.messageCode) && event.messageCode === code && Number.isFinite(atMs) && typeof event.session === "string" && event.session && typeof event.event === "string" && event.event) {
            occurrences.push({ at: event.at, atMs, session: event.session, event: event.event, order });
          }
          order += 1;
        } catch {
          void 0;
        }
      }
    }
  } catch {
    return [];
  }
  return occurrences.sort((left, right) => right.atMs - left.atMs || right.order - left.order);
}

export function renderMessageDetails(entry, occurrences) {
  const lines = [messageEntryHeader(entry)];
  if (occurrences.length === 0) {
    lines.push("Occurrences are not recorded for this message kind.");
  } else {
    lines.push(`Occurrences: ${occurrences.length}`);
    for (const occurrence of occurrences.slice(0, 10)) {
      lines.push(`${occurrence.at}  ${occurrence.session}  ${occurrence.event}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function sessionIdFromArgs(argv, env) {
  const index = argv.indexOf("--session");
  const selected = index === -1 ? null : argv[index + 1];
  return typeof selected === "string" && selected && !selected.startsWith("--") ? selected : env.CLAUDE_CODE_SESSION_ID || null;
}

export const RECORD_REASON_EXAMPLE = 'example: --record <id>=rejected --reason-for <id> "why it failed"';

export class UsageError extends Error {}

export function validateArgumentShape(argv) {
  const flags = new Set(["--json", "--audit", "--all", "--prune-dead", "--yes", "--identities", "--by-day", "--messages", "--unsettled", "--trace", "--accept-failed-transport"]);
  const values = new Map([["--message", 1], ["--days", 1], ["--source", 1], ["--reason", 1], ["--failure-kind", 1], ["--reason-for", 2], ["--failure-kind-for", 2]]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (flags.has(token)) continue;
    if (token === "--session") {
      if (typeof argv[index + 1] === "string" && argv[index + 1] && !argv[index + 1].startsWith("--")) index += 1;
      continue;
    }
    if (token === "--record") {
      const pair = argv[index + 1];
      if (typeof pair !== "string" || pair.startsWith("--")) throw new UsageError(`--record: missing <id>=<verdict> pair`);
      do {
        try { parseRecordPair(argv[index + 1]); }
        catch (error) { throw new UsageError(`${argv[index + 1]}: ${error.message.split("\n")[0]}`); }
        index += 1;
      } while (typeof argv[index + 1] === "string" && !argv[index + 1].startsWith("--"));
      continue;
    }
    if (values.has(token)) {
      for (let offset = 1; offset <= values.get(token); offset += 1) {
        const value = argv[index + offset];
        if (typeof value !== "string" || !value || value.startsWith("--")) throw new UsageError(`${token}: missing value`);
      }
      index += values.get(token);
      continue;
    }
    throw new UsageError(`${String(token)}: unknown argument`);
  }
  const selected = argv.includes("--messages") ? "messages"
    : argv.includes("--message") ? "message"
      : argv.includes("--audit") ? "audit"
        : argv.includes("--record") ? "record"
          : argv.includes("--prune-dead") ? "prune"
            : argv.includes("--unsettled") ? "unsettled"
              : argv.includes("--trace") ? "trace"
                : argv.includes("--session") ? "session" : "report";
  const allowed = {
    messages: new Set(["--messages"]),
    message: new Set(["--message"]),
    audit: new Set(["--audit", "--all", "--days", "--session", "--json"]),
    record: new Set(["--record", "--source", "--reason", "--reason-for", "--failure-kind", "--failure-kind-for", "--accept-failed-transport", "--json"]),
    prune: new Set(["--prune-dead", "--yes", "--json"]),
    unsettled: new Set(["--unsettled", "--json"]),
    trace: new Set(["--trace", "--session", "--json"]),
    session: new Set(["--session", "--json"]),
    report: new Set(["--json", "--all", "--identities", "--by-day"])
  }[selected];
  for (const token of argv) {
    if (token.startsWith("--") && !allowed.has(token)) throw new UsageError(`${token}: cannot be used with this request`);
  }
}

function recordReasonGrammarError(message) {
  return new TypeError(`${message}\n${RECORD_REASON_EXAMPLE}`);
}

function parseRecordPair(value) {
  if (typeof value !== "string") {
    throw recordReasonGrammarError("--record requires an <id>=<verdict> pair.");
  }
  const separator = value.indexOf("=");
  if (separator <= 0 || separator !== value.lastIndexOf("=")) {
    throw recordReasonGrammarError("--record requires an <id>=<verdict> pair.");
  }
  const id = value.slice(0, separator);
  const rawVerdict = value.slice(separator + 1);
  const overrideSuffix = ":accept-failed-transport";
  const acceptFailedTransport = rawVerdict.endsWith(overrideSuffix);
  const verdict = acceptFailedTransport ? rawVerdict.slice(0, -overrideSuffix.length) : rawVerdict;
  if (!FUSION_TASK_ID_PATTERN.test(id) && !ENGINE_JOB_ID_PATTERN.test(id)) {
    throw recordReasonGrammarError("--record id must be a Fusion task id or a 32 character engine job id.");
  }
  if (!RECORD_VERDICTS.has(verdict)) {
    throw recordReasonGrammarError("--record verdict must be accepted, rejected, or unverified.");
  }
  return { id, verdict, acceptFailedTransport };
}

export function parseRecordArguments(argv, { allowPerPairReasons = false } = {}) {
  const records = [];
  let source = null;
  let reason = null;
  let failureKind = null;
  const reasonsById = new Map();
  const failureKindsById = new Map();
  let asJson = false;
  let acceptFailedTransport = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--record") {
      records.push(parseRecordPair(argv[index + 1]));
      index += 1;
      while (typeof argv[index + 1] === "string" && !argv[index + 1].startsWith("--")) {
        try {
          records.push(parseRecordPair(argv[index + 1]));
        } catch {
          break;
        }
        index += 1;
      }
      continue;
    }
    if (token === "--reason-for") {
      const id = argv[index + 1];
      const pairReason = argv[index + 2];
      if (!allowPerPairReasons) {
        throw recordReasonGrammarError("--reason-for is available only through the raw-args transport.");
      }
      if ((!FUSION_TASK_ID_PATTERN.test(id) && !ENGINE_JOB_ID_PATTERN.test(id)) || typeof pairReason !== "string" || !pairReason) {
        throw recordReasonGrammarError("--reason-for requires a valid record id and nonempty reason text.");
      }
      if (reasonsById.has(id)) {
        throw recordReasonGrammarError(`Duplicate --reason-for for record ${id}.`);
      }
      reasonsById.set(id, pairReason);
      index += 2;
      continue;
    }
    if (token === "--failure-kind-for") {
      const id = argv[index + 1];
      const pairFailureKind = argv[index + 2];
      if (!allowPerPairReasons) {
        throw new TypeError("--failure-kind-for is available only through the raw-args transport.");
      }
      if (!SEMANTIC_FAILURE_KINDS.has(pairFailureKind)) {
        throw new TypeError("The --failure-kind value must be one of intent_override, scope_rewrite, wrong_approach, style_mismatch, oversized.");
      }
      if (!FUSION_TASK_ID_PATTERN.test(id) && !ENGINE_JOB_ID_PATTERN.test(id)) {
        throw new TypeError("--failure-kind-for requires one record id and one failure kind.");
      }
      if (failureKindsById.has(id)) {
        throw new TypeError(`Duplicate --failure-kind-for for record ${id}.`);
      }
      failureKindsById.set(id, pairFailureKind);
      index += 2;
      continue;
    }
    if (token === "--source") {
      if (source !== null || !RECORD_SOURCES.has(argv[index + 1])) {
        throw new TypeError("--source must be collector or main-loop.");
      }
      source = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--reason") {
      if (reason !== null || typeof argv[index + 1] !== "string" || !argv[index + 1]) {
        throw recordReasonGrammarError(reason !== null ? "Duplicate --reason." : "--reason requires nonempty text.");
      }
      reason = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--failure-kind") {
      const candidate = argv[index + 1];
      if (!SEMANTIC_FAILURE_KINDS.has(candidate)) {
        throw new TypeError("The --failure-kind value must be one of intent_override, scope_rewrite, wrong_approach, style_mismatch, oversized.");
      }
      if (failureKind !== null) {
        throw new TypeError("Duplicate --failure-kind.");
      }
      failureKind = candidate;
      index += 1;
      continue;
    }
    if (token === "--json" && !asJson) {
      asJson = true;
      continue;
    }
    if (token === "--accept-failed-transport") {
      if (acceptFailedTransport) {
        throw new TypeError("Duplicate --accept-failed-transport.");
      }
      acceptFailedTransport = true;
      continue;
    }
    throw recordReasonGrammarError(`Unsupported --record argument: ${String(token)}.`);
  }
  const knownPairIds = [...new Set(records.map((record) => record.id))];
  for (const id of reasonsById.keys()) {
    if (!knownPairIds.includes(id)) {
      throw recordReasonGrammarError(`--reason-for record id ${id} does not match a recorded pair. Known pair ids: ${knownPairIds.join(", ") || "(none)"}.`);
    }
  }
  if (records.length === 0) {
    throw recordReasonGrammarError("At least one --record <id>=<verdict> pair is required.");
  }
  const rejectedRecords = records.filter((record) => record.verdict === "rejected");
  if (reason !== null && rejectedRecords.length === 0) {
    throw recordReasonGrammarError("--reason requires at least one rejected --record pair.");
  }
  if (failureKind !== null && rejectedRecords.length === 0) {
    throw new TypeError("--failure-kind requires at least one rejected --record pair.");
  }
  for (const id of failureKindsById.keys()) {
    const matched = records.filter((record) => record.id === id);
    if (matched.length === 0) {
      throw new TypeError(`--failure-kind-for record id ${id} does not match a recorded pair. Known pair ids: ${knownPairIds.join(", ") || "(none)"}.`);
    }
    if (matched.some((record) => record.verdict !== "rejected")) {
      throw new TypeError(`--failure-kind-for applies only to rejected record ${id}.`);
    }
  }
  if (failureKind !== null && rejectedRecords.every((record) => failureKindsById.has(record.id))) {
    throw new TypeError("--failure-kind has no rejected pair without --failure-kind-for.");
  }
  for (const record of records) {
    if (record.verdict !== "rejected" && reasonsById.has(record.id)) {
      throw recordReasonGrammarError(`--reason-for applies only to rejected record ${record.id}.`);
    }
    record.reason = record.verdict === "rejected" ? reasonsById.get(record.id) ?? reason : null;
    record.failureKind = record.verdict === "rejected" ? failureKindsById.get(record.id) ?? failureKind : null;
    if (record.verdict === "rejected") {
      if (record.reason === null) {
        throw recordReasonGrammarError(`Rejected verdict for ${record.id} requires --reason or --reason-for <id> <text>.`);
      }
    }
  }
  return { records, source: source ?? "main-loop", asJson, acceptFailedTransport };
}

export function isStrictDirectRecordArguments(argv) {
  try {
    let records = 0;
    const flags = new Set();
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index];
      if (token === "--record") {
        parseRecordPair(argv[index + 1]);
        records += 1;
        index += 1;
        while (typeof argv[index + 1] === "string" && !argv[index + 1].startsWith("--")) {
          try {
            parseRecordPair(argv[index + 1]);
          } catch {
            break;
          }
          records += 1;
          index += 1;
        }
        continue;
      }
      if (token === "--source") {
        const value = argv[index + 1];
        if ((value !== "collector" && value !== "main-loop") || flags.has(token)) {
          return false;
        }
        flags.add(token);
        index += 1;
        continue;
      }
      if (token === "--json" || token === "--accept-failed-transport") {
        if (flags.has(token)) {
          return false;
        }
        flags.add(token);
        continue;
      }
      return false;
    }
    return records > 0;
  } catch {
    return false;
  }
}

export function isStrictDirectReportOrMaintenanceArguments(argv) {
  if (argv.length === 1 && argv[0] === "--messages") {
    return true;
  }
  if (argv.length === 2 && argv[0] === "--message" && isIntegerToken(argv[1])) {
    return true;
  }
  const flags = new Set(["--json", "--audit", "--all", "--prune-dead", "--identities", "--by-day"]);
  return argv.every((token) => flags.delete(token));
}

export function hasRejectedRecordPair(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--record") {
      continue;
    }
    for (let pairIndex = index + 1; typeof argv[pairIndex] === "string" && !argv[pairIndex].startsWith("--"); pairIndex += 1) {
      if (parseRecordPair(argv[pairIndex]).verdict === "rejected") {
        return true;
      }
    }
  }
  return false;
}
