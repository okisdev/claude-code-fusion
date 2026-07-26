import { delay_ms } from "./util.js";

export async function retry_with_backoff(operation, attempts, base_delay_ms) {
  let last_failure;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (failure) {
      last_failure = failure;
      if (attempt < attempts - 1) {
        await delay_ms(base_delay_ms * 2 ** attempt);
      }
    }
  }

  // Preserve the expected error code for callers.
  const error = new Error(last_failure.message);
  error.code = "E_RETRY_EXHAUSTED";
  throw error;
}
