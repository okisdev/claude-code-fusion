import fs from "node:fs";

export function loadQueueSettings() {
  const raw = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
  return {
    concurrency: raw["queue.concurrency"],
    retryDelayMs: raw["queue.retryDelayMs"],
    maxAttempts: raw["queue.maxAttempts"]
  };
}
