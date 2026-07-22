# Emberflow changelog: v4.0.0 through v4.2.0, current series

This file continues from changelog-v3.md. v4.2.0 is the latest version covered by this corpus and is the current release.

## v4.0.0, released 2025-06-30

A major release built around a new scheduler. This release raises the default queue.concurrency to take advantage of the new scheduler; see migration-guide-v3-to-v4.md for the exact new value and for guidance on tuning it further on larger hosts. retry.backoff_ms and webhook.timeout_ms are unaffected by this release.

## v4.1.0, released 2025-08-18

Raises the default webhook.timeout_ms to better support the slow downstream endpoints that several large deployments reported. See release-notes-v4.1.0.md for the exact new value and the supporting data. queue.concurrency and retry.backoff_ms are unchanged from v4.0.0.

## v4.2.0, released 2025-10-05, current release

Lowers the default retry.backoff_ms to fix a regression introduced by the v3.2.0 tuning pass, which had overcorrected and left retries waiting longer than necessary after failures that clear quickly. See deprecation-notice.md for the exact new value and further background. queue.concurrency and webhook.timeout_ms are unchanged from v4.1.0.
