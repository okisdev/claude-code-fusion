The corpus folder in this task's fixtures holds documentation for Emberflow, a fictional workflow automation engine that reads its settings from an emberflow.yml file. The documents mix full changelogs, standalone release notes for individual versions, a configuration reference, a migration guide, a deprecation notice, a frequently asked questions page, a known issues list, and a support ticket digest, together covering the project's entire release history from its first stable version through its current version. Several of these documents state a configuration default that was accurate when that document was written but was changed again in a later release, so finding a value for a key in one document does not mean that value is still current; read enough of the corpus to confirm which value for each key the current version actually ships, not merely a value the key has held at some point in its history.

Answer the following question about three settings read from emberflow.yml: queue.concurrency, retry.backoff_ms, and webhook.timeout_ms. For each of the three keys, determine the value it currently defaults to in the latest version covered by this corpus, and the version in which that current value was most recently set. A key's current value was most recently set in the latest version whose changelog entry changes that key, even when later versions have shipped since without touching it; for example, if a key was set to 10 in version 1.0.0 and no later version ever changes it again, then 10 from version 1.0.0 remains both its current value and the version of its most recent change, no matter how many later versions have shipped since.

Write your answer as a single JSON file named answer.json in the root of your working directory, containing nothing but that JSON. Only answer.json is graded; you may leave other working files in place if that helps you, but nothing else is read. Use exactly the shape below, with exactly these three top level keys spelled exactly as shown, each holding an object with exactly two fields: final_default as a JSON number, not a string, and changed_in_version as a JSON string holding a plain three part version number with no leading v, matching the version headings used in this corpus's changelogs, for example "4.0.0".

```json
{
  "queue_concurrency": { "final_default": 0, "changed_in_version": "0.0.0" },
  "retry_backoff_ms": { "final_default": 0, "changed_in_version": "0.0.0" },
  "webhook_timeout_ms": { "final_default": 0, "changed_in_version": "0.0.0" }
}
```

The zeroes above are placeholders that show the required shape only; replace every final_default and every changed_in_version with the value you determine from the corpus, and do not otherwise change the shape.
