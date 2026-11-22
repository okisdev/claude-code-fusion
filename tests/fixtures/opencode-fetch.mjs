import fs from "node:fs";
import { goApiModels, goApiUsage } from "../lib/opencode-harness.mjs";

globalThis.fetch = async (url, options = {}) => {
  if (!/^https:\/\/opencode\.ai\/inference\/go\/v1\/(?:models|usage)$/.test(url)) throw new Error("Unexpected test network request.");
  const sessionId = options.headers?.["x-opencode-session"];
  if (!sessionId) throw new Error("Missing session header.");
  if (options.headers.Authorization && options.headers.Authorization !== "Bearer opencode-test-credential") throw new Error("Unexpected test credential.");
  if (process.env.FAKE_OPENCODE_FETCH_LOG) fs.appendFileSync(process.env.FAKE_OPENCODE_FETCH_LOG, `${JSON.stringify({ url, sessionId })}\n`);
  const status = Number(process.env.FAKE_OPENCODE_HTTP_STATUS ?? 200);
  return { ok: status === 200, status, json: async () => url.endsWith("/models") ? { data: goApiModels } : goApiUsage };
};
