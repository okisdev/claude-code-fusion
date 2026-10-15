export const ZERO_USAGE = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0
});

function usageField(value, ...keys) {
  for (const key of keys) {
    if (Object.hasOwn(value, key)) {
      const field = value[key];
      return Number.isSafeInteger(field) && field >= 0 ? field : null;
    }
  }
  return null;
}

export function normalizeCumulativeUsage(value) {
  const raw = value?.total_token_usage ?? value?.totalTokenUsage ?? value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const inputTokens = usageField(raw, "inputTokens", "input_tokens");
  const cachedInputTokens = usageField(raw, "cachedInputTokens", "cached_input_tokens");
  const outputTokens = usageField(raw, "outputTokens", "output_tokens");
  const reasoningOutputTokens = usageField(raw, "reasoningOutputTokens", "reasoning_output_tokens");
  if ([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens].some((field) => field == null)) {
    return null;
  }
  if (cachedInputTokens > inputTokens || reasoningOutputTokens > outputTokens) {
    return null;
  }
  const reportedTotal = usageField(raw, "totalTokens", "total_tokens");
  const calculatedTotal = inputTokens + outputTokens;
  if (!Number.isSafeInteger(calculatedTotal)) {
    return null;
  }
  if (reportedTotal != null && reportedTotal !== calculatedTotal) {
    return null;
  }
  const totalTokens = reportedTotal ?? calculatedTotal;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

export function subtractUsage(endValue, startValue) {
  const end = normalizeCumulativeUsage(endValue);
  const start = normalizeCumulativeUsage(startValue);
  if (!end || !start) {
    return null;
  }
  const result = {};
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]) {
    const value = end[key] - start[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    result[key] = value;
  }
  return result;
}
