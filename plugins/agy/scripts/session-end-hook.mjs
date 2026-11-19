#!/usr/bin/env node

import { cancelJobRecord, cleanupRawCommandTransportsForSession } from "./agy-companion.mjs";
import * as state from "./lib/state.mjs";
import { runSessionEnd } from "./lib/session-end.mjs";

await runSessionEnd({ state, sweep: state.sweepAgyRuns, cancelJobRecord, cleanupRawCommandTransportsForSession });
process.exit(0);
