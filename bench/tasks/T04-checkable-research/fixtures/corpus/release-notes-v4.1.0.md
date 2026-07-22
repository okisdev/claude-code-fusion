# Emberflow v4.1.0 release notes

Released 2025-08-18.

## Webhook timeout increase

Several large deployments reported webhook calls to slow internal endpoints being cut off before they could respond, even with the timeout that v3.0.0 kept at 5000 milliseconds. This release raises the default webhook.timeout_ms from 5000 to 8000. Deployments whose webhook endpoints already respond quickly should see no behavior change; deployments with slower endpoints should see fewer spurious timeout failures.

## Other changes

This release does not change queue.concurrency or retry.backoff_ms. See changelog-v4.md for the full v4.1.0 entry.
