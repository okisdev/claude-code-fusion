const KEY_ENV = "TYPESAFE_API_KEY";
const ENDPOINT_ENV = "FUSION_JEV_ENDPOINT";
const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const PINNED_MODEL = "jev-1.13.0";
const STATE_MAX_CHARS = 24_000;
const REQUEST_TIMEOUT_MS = 1_200;

function configured(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

async function askJev(state, questions, { env = process.env, model = PINNED_MODEL } = {}) {
  const key = configured(env[KEY_ENV]);
  if (!key) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(configured(env[ENDPOINT_ENV]) ?? DEFAULT_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model, state: String(state).slice(0, STATE_MAX_CHARS), questions })
    });
    if (!response.ok) {
      return null;
    }
    const answers = (await response.json())?.answers;
    return answers && typeof answers === "object" && !Array.isArray(answers) ? answers : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export { PINNED_MODEL, askJev };
