# Emberflow known issues

## Resolved: webhook timeout experiment reverted before v3.0.0

The v3.0.0-beta.1 build shipped with an experimental webhook.timeout_ms default of 10000, meant to cut down even further on premature timeouts beyond the v2.0.0 default of 5000. Beta testers found that connection pools on some downstream services became exhausted when many slow calls were held open at once at the longer timeout. The experiment was withdrawn, and the v3.0.0 stable release shipped with webhook.timeout_ms unchanged at 5000. The default was revisited again later, in v4.1.0; see release-notes-v4.1.0.md.

## Open: emberflow doctor misreports scheduler.mode right after a config reload

Running emberflow doctor immediately after emberflow reload can print the previous scheduler.mode value for a few seconds before the cache refreshes. Rerunning the command shows the correct value. Tracked for a fix in an upcoming release.
