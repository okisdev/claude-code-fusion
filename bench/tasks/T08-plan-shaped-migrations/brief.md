# Plan shaped configuration migrations

This project is a small Node ESM package with three independent settings modules under fixtures. Each module pairs one config file with one loader that reads it, and each module's config file still uses an old format that needs migrating to the shape described below. The three modules share no files, imports, or state, so the three packages below can be migrated in any order or in parallel. Every loader's exported function name and its returned field names stay exactly as they are today; only how each loader reads its own config file changes.

## Package 1: Queue settings

`queue-settings/config.json` is a flat JSON object whose keys are dotted strings, such as `"queue.concurrency"`. Migrate it to a nested JSON object with one top level `queue` key holding `concurrency`, `retryDelayMs`, and `maxAttempts` as plain fields, keeping their current values. Update `queue-settings/load-queue-settings.js` so `loadQueueSettings()` reads the new nested `queue` object instead of the old dotted keys. `loadQueueSettings()` must keep returning an object with the same `concurrency`, `retryDelayMs`, and `maxAttempts` fields it returns today.

## Package 2: Mailer settings

`mailer-settings/mailer.env` is a plain text file of `MAILER_HOST`, `MAILER_PORT`, and `MAILER_FROM` lines in `key=value` form. Replace it with a JSON file at `mailer-settings/mailer.json` holding `host`, `port`, and `from` fields, with `port` written as a JSON number rather than text, and remove `mailer.env` once `mailer.json` takes over. Update `mailer-settings/load-mailer-settings.js` so `loadMailerSettings()` reads `mailer.json` instead of parsing the old text file. `loadMailerSettings()` must keep returning an object with the same `host`, `port`, and `from` fields it returns today, with `port` still a number.

## Package 3: Notifier settings

`notifier-settings/config.json` is a nested JSON object whose `notifier` key holds `channel`, `retryCount`, and `silentMode` fields. `retryCount` and `silentMode` are deprecated field names. Rename `retryCount` to `maxRetries` and `silentMode` to `muted`, keeping their current values and keeping `channel` unchanged. Update `notifier-settings/load-notifier-settings.js` so `loadNotifierSettings()` reads the renamed fields. `loadNotifierSettings()` must keep returning an object with the same `channel`, `maxRetries`, and `muted` fields it returns today.

Everything here uses Node's built in modules only. Do not add dependencies, and do not change any exported function's name or its public behavior beyond what each package above asks for.
