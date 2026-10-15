import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(new URL("../../grok-companion.mjs", import.meta.url));
const ROOT_DIR = path.resolve(path.dirname(SELF_PATH), "..");
const REVIEW_PROMPT_FILE = path.join(ROOT_DIR, "prompts", "review.md");
const STOP_GATE_PROMPT_FILE = path.join(ROOT_DIR, "prompts", "stop-gate.md");

export { SELF_PATH, ROOT_DIR, REVIEW_PROMPT_FILE, STOP_GATE_PROMPT_FILE };
