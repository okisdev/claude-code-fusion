# Emberflow frequently asked questions

## What does queue.concurrency control?

It controls how many worker threads process jobs at the same time. Raising it lets more jobs run in parallel at the cost of more memory and CPU use per host.

## Is 1200 milliseconds still the default retry backoff?

This question comes up often because 1200 milliseconds was the default introduced in v3.2.0 and is still what many teams remember. Always check the changelog for the release actually running in your deployment, since this default has changed more than once since v3.2.0.

## Can retries be disabled entirely?

Yes, set retry.backoff_ms to 0 and retry.max_attempts to 1. This is not recommended for production deployments.

## Does Emberflow support cron style schedules?

Yes, a job definition's schedule key accepts a standard five field cron expression.
