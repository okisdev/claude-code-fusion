# Emberflow configuration reference

This reference lists settings read from emberflow.yml along with their default values. It was last revised for the v3.2.0 release; consult the changelog for any default that changed in a later release.

- queue.concurrency: number of worker threads processing jobs at once. Default as of this revision: 6.
- retry.backoff_ms: milliseconds to wait before retrying a failed job. Default as of this revision: 1200.
- webhook.timeout_ms: milliseconds to wait for a webhook call to respond before it is treated as failed. Default as of this revision: 5000.
- log.level: logging verbosity, one of quiet, normal, or verbose. Default: normal, unchanged since v1.0.0.
- scheduler.mode: internal scheduling strategy, one of fifo or priority. Default: fifo, unchanged since v1.0.0.
