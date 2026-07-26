export async function map_concurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next_index = 0;

  async function run_worker() {
    while (next_index < items.length) {
      const current_index = next_index;
      next_index += 1;
      results[current_index] = await worker(items[current_index], current_index);
    }
  }

  const workers = [];
  const worker_count = Math.min(limit, items.length);
  for (let index = 0; index < worker_count; index += 1) {
    workers.push(run_worker());
  }
  await Promise.all(workers);
  return results;
}
