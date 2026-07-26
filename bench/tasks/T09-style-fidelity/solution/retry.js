import { app_error } from "./errors.js";
import { delay_ms } from "./util.js";

export function retry_with_backoff(operation, attempts, base_delay_ms) {
  let remaining_attempts = attempts;
  let delay_multiplier = 1;
  let last_failure;

  function try_operation() {
    return Promise.resolve()
      .then(operation)
      .catch((failure) => {
        last_failure = failure;
        remaining_attempts -= 1;
        if (remaining_attempts === 0) {
          return Promise.reject(app_error("RETRY_EXHAUSTED", last_failure.message));
        }
        const delay = base_delay_ms * delay_multiplier;
        delay_multiplier *= 2;
        return delay_ms(delay).then(try_operation);
      });
  }

  return try_operation();
}
