# Emberflow migration guide: v3.x to v4.0.0

This guide helps teams upgrading from any v3.x release to v4.0.0.

## Scheduler rewrite

v4.0.0 replaces the old fifo scheduler with a new engine that spreads jobs across worker threads more evenly under uneven workloads. As part of this rewrite, the default queue.concurrency changes from 6, the v3.0.0 stable value, to 12. Most deployments should leave this at the new default. Teams running Emberflow on hosts with more than 64 gigabytes of memory available to the process may consider manually raising queue.concurrency to 16, but 12 is the value v4.0.0 ships as its default for every other host.

## Retry and webhook settings

This migration does not touch retry.backoff_ms or webhook.timeout_ms. Both keys keep whatever value they held under v3.2.0 until a later release changes them; see changelog-v4.md for when that happens.

## Removed keys

The legacy worker.threads key, deprecated since v2.0.0 in favor of queue.concurrency, is removed entirely in v4.0.0. Any emberflow.yml still setting worker.threads should have that line deleted; the key is silently ignored otherwise.
