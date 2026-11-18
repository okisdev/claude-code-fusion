#!/usr/bin/env node

import { cancelJobRecord, cleanupRawCommandTransportsForSession } from "./devin-companion.mjs";
import * as state from "./lib/state.mjs";
import { runSessionEnd } from "./lib/session-end.mjs";

await runSessionEnd({ state, sweep: state.sweepDevinRuns, cancelJobRecord, cleanupRawCommandTransportsForSession });
process.exit(0);
