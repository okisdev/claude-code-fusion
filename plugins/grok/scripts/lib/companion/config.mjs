

const STOP_GATE_OPTION_ENV = "CLAUDE_PLUGIN_OPTION_STOP_GATE";
const CONTINUITY_POLICY_ENV = "GROK_COMPANION_CONTINUITY_POLICY";
const STOP_GATE_TIMEOUT_MS = 240000;
const STOP_GATE_MAX_TURNS = 15;
const WAIT_POLL_ENV = "GROK_COMPANION_WAIT_POLL_MS";
const WAIT_TIMEOUT_ENV = "GROK_COMPANION_WAIT_TIMEOUT_MS";
const BACKGROUND_DELIVERY_ENV = "GROK_COMPANION_BACKGROUND_DELIVERY";
const DEFAULT_WAIT_POLL_MS = 2000;
const DEFAULT_WAIT_TIMEOUT_MS = 570000;
const RECORD_ACCEPTANCE_JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const RECORD_ACCEPTANCE_SOURCES = new Set(["collector", "main-loop", "stats"]);
const RECORD_ACCEPTANCE_VALUES = new Set(["accepted", "rejected", "unverified"]);
const SEMANTIC_FAILURE_KINDS = new Set(["intent_override", "scope_rewrite", "wrong_approach", "style_mismatch", "oversized"]);
const MAX_WAIT_TIMEOUT_MS = 570000;
const CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 500;
const TESTED_VERSION_MIN = [1, 0, 14];
const TESTED_VERSION_MAX = [1, 0, 42];
const GROK_VERSION_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
const CONTINUITY_POLICIES = new Set(["manual", "claude-session"]);
const HISTORY_STATUSES = new Set(["running", "done", "error", "cancelled"]);
const HISTORY_MODES = new Set(["consult", "write"]);
const HISTORY_DELIVERIES = new Set(["foreground", "manual", "managed"]);
const HISTORY_DELIVERY_STATUSES = new Set(["pending", "delivered", "collected"]);
const MAX_JSON_SCHEMA_BYTES = 256 * 1024;
const HISTORY_SEMANTIC_STATUSES = new Set(["unverified", "accepted", "rejected"]);
const HISTORY_FAILURE_KINDS = new Set([
  "quota",
  "auth",
  "missing_cli",
  "setup",
  "rate_limited",
  "network",
  "timeout",
  "error",
  "permission",
  "cancelled",
  "input",
  "died",
  "resource",
  "sandbox",
  "transport",
  "policy",
  "turn_limit"
]);
const GROK_ROLES = new Set(["burst", "independence", "live-web", "large-context"]);
const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings", "next_steps"],
  properties: {
    verdict: { type: "string", enum: ["approve", "needs-attention"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "body"],
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          file: { type: "string" },
          line_start: { type: "integer", minimum: 1 },
          line_end: { type: "integer", minimum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          recommendation: { type: "string" }
        }
      }
    },
    next_steps: { type: "array", items: { type: "string" } }
  }
};

export { STOP_GATE_OPTION_ENV, CONTINUITY_POLICY_ENV, STOP_GATE_TIMEOUT_MS, STOP_GATE_MAX_TURNS, WAIT_POLL_ENV, WAIT_TIMEOUT_ENV, BACKGROUND_DELIVERY_ENV, DEFAULT_WAIT_POLL_MS, DEFAULT_WAIT_TIMEOUT_MS, RECORD_ACCEPTANCE_JOB_ID_PATTERN, RECORD_ACCEPTANCE_SOURCES, RECORD_ACCEPTANCE_VALUES, SEMANTIC_FAILURE_KINDS, MAX_WAIT_TIMEOUT_MS, CONTINUE_PROMPT, JOB_ID_PATTERN, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, TESTED_VERSION_MIN, TESTED_VERSION_MAX, GROK_VERSION_PROBE_TIMEOUT_MS, DEFAULT_QUOTA_COOLDOWN_MS, CONTINUITY_POLICIES, HISTORY_STATUSES, HISTORY_MODES, HISTORY_DELIVERIES, HISTORY_DELIVERY_STATUSES, MAX_JSON_SCHEMA_BYTES, HISTORY_SEMANTIC_STATUSES, HISTORY_FAILURE_KINDS, GROK_ROLES, REVIEW_OUTPUT_SCHEMA };
