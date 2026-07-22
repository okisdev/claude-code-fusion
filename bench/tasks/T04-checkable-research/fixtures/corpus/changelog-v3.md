# Emberflow changelog: v3.0.0-beta.1 through v3.2.0

This file continues from changelog-v1-v2.md and covers the v3 series. The v4 series is covered separately in changelog-v4.md.

## v3.0.0-beta.1, released 2024-11-01

An experimental beta offered for feedback ahead of the v3.0.0 stable release. This beta proposes raising the default webhook.timeout_ms from 5000 to 10000, to cut down further on premature timeouts against slow endpoints. The proposal is flagged experimental in the beta notes and is never promoted to a stable release; see known-issues.md for why it was withdrawn before v3.0.0 shipped.

## v3.0.0, released 2025-01-08

The first stable release in the v3 series. Based on feedback gathered during the beta, the default queue.concurrency is lowered from 8 to 6 to improve scheduling stability on smaller hosts. The webhook.timeout_ms proposal from v3.0.0-beta.1 is reverted for this stable release, so webhook.timeout_ms stays at 5000, unchanged from v2.0.0.

## v3.2.0, released 2025-03-14

A bug fix release. The default retry.backoff_ms is raised from 1000 to 1200 after telemetry showed retries still bunching together under sustained load. queue.concurrency and webhook.timeout_ms are unchanged from v3.0.0 in this release.
