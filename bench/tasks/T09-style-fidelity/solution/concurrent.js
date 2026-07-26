import { app_error } from "./errors.js";

export function map_concurrent(items, limit, worker) {
  if (items.length === 0) {
    return Promise.resolve([]);
  }
  if (limit < 1) {
    return Promise.reject(app_error("INVALID_LIMIT", "limit must be at least one"));
  }

  const results = new Array(items.length);
  const workers = [];
  const worker_count = Math.min(limit, items.length);
  let next_index = 0;

  function run_worker() {
    const current_index = next_index;
    next_index += 1;
    return Promise.resolve()
      .then(() => worker(items[current_index], current_index))
      .then((result) => {
        results[current_index] = result;
        if (next_index < items.length) {
          return run_worker();
        }
        return undefined;
      });
  }

  for (let index = 0; index < worker_count; index += 1) {
    workers.push(run_worker());
  }
  return Promise.all(workers).then(() => results);
}
