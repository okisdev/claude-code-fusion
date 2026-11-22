#!/usr/bin/env node
import { cancelJobRecord, cleanupRawCommandTransportsForSession } from "./opencode-companion.mjs";
import state, { sweepOpencodeRuns } from "./lib/engine-state.mjs";
import { runSessionEnd } from "./lib/session-end.mjs";

await runSessionEnd({ state, sweep: sweepOpencodeRuns, cancelJobRecord, cleanupRawCommandTransportsForSession });
process.exit(0);
