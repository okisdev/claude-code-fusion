# Emberflow changelog: v1.0.0 through v2.3.0

This file covers the earliest Emberflow releases, from the first stable release through the rest of the v2 series. The v3 series continues in changelog-v3.md, and the v4 series, which is the current series as of this corpus, continues after that in changelog-v4.md.

## v1.0.0, released 2024-01-10

The first stable release of Emberflow. Its shipped defaults are queue.concurrency at 4, retry.backoff_ms at 500, and webhook.timeout_ms at 2000. These were chosen conservatively for small deployments and were expected to be tuned upward as real world usage came in.

## v1.4.0, released 2024-04-02

Raises the default retry.backoff_ms from 500 to 750. Early adopters running high volume queues reported retries landing in tight clusters right after a failure, and the wider backoff spreads them out.

## v2.0.0, released 2024-07-15

A significant release. The default queue.concurrency moves from 4 to 8 to take advantage of multi core hosts, and the default webhook.timeout_ms moves from 2000 to 5000 after reports of slow downstream endpoints being cut off before they could respond. See release-notes-v2.0.0.md in this corpus for the full rationale behind both changes.

## v2.3.0, released 2024-09-20

Raises the default retry.backoff_ms again, from 750 to 1000, as part of a broader retry tuning pass ahead of planning for the v3 series.
