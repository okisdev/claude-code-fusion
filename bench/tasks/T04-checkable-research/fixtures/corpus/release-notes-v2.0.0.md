# Emberflow v2.0.0 release notes

Released 2024-07-15.

## Concurrency

The default queue.concurrency moves from 4 to 8. Hosts with more than one core were leaving capacity unused under the v1 defaults, and 8 was chosen as a value that keeps memory use reasonable on the smallest hosts Emberflow supports while still using multiple cores.

## Webhook timeout

The default webhook.timeout_ms moves from 2000 to 5000. Reports came in of downstream endpoints, particularly ones waking from a cold start, taking longer than 2 seconds to respond even though they eventually succeeded. 5000 milliseconds gives those endpoints enough room without waiting indefinitely.

## Looking ahead

Both values are expected to keep moving as more production data comes in; see later release notes and the changelog for what changes next.
