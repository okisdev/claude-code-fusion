#!/usr/bin/env node

import { cancelJobRecord, cleanupRawCommandTransportsForSession } from "./cursor-companion.mjs";
import * as state from "./lib/state.mjs";
import { runSessionEnd } from "./lib/session-end.mjs";

await runSessionEnd({ state, sweep: state.sweepCursorHomes, cancelJobRecord, cleanupRawCommandTransportsForSession });
process.exit(0);
