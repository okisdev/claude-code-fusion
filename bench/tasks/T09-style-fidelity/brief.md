Add two new files to this project: `retry.js` and `concurrent.js`.

`retry.js` must export `retry_with_backoff(operation, attempts, base_delay_ms)`. It calls `operation()` up to `attempts` times and resolves with the first success. Between failed attempts, wait for `base_delay_ms` doubled for each retry: base, twice the base, four times the base, and so on. When all attempts fail, reject with `app_error("RETRY_EXHAUSTED", ...)` carrying the last failure message.

`concurrent.js` must export `map_concurrent(items, limit, worker)`. It resolves to results in input order, never runs more than `limit` workers at once, resolves to an empty array for empty input, and rejects with the worker's first error.

STYLE CONTRACT

This contract is binding even where it conflicts with the writer's habits.

1. Exported function names MUST be snake_case.
2. The `async` and `await` keywords MUST NOT appear anywhere. Use explicit promise chains.
3. Class declarations MUST NOT appear.
4. Every constructed error MUST come from `app_error` in `./errors.js`. `new Error(` MUST NOT appear.
5. `.js` files MUST NOT contain comments.
6. Named exports only. `export default` MUST NOT appear.
