# Emberflow deprecation and regression notice, v4.2.0

Released 2025-10-05.

## Retry backoff regression fix

The v3.2.0 release raised the default retry.backoff_ms from 1000 to 1200 to address retries bunching together under sustained load. Telemetry gathered over the following two releases showed this went too far: jobs failing for reasons that clear up quickly, such as a brief network blip, ended up waiting longer than necessary before retrying. This release lowers the default retry.backoff_ms from 1200 to 900, a value telemetry shows keeps retries spread out during sustained load without punishing quick recoveries too harshly.

## Deprecated: retry.jitter_legacy

The retry.jitter_legacy flag, which toggled an older jitter algorithm, is deprecated as of this release and will be removed in v5.0.0. New deployments should not set it; the current retry.backoff_ms default already accounts for jitter internally.
