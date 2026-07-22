export function assertTopic(topic) {
  if (typeof topic !== "string") {
    throw new TypeError("topic must be a string");
  }
}

export function assertPattern(pattern) {
  if (typeof pattern !== "string") {
    throw new TypeError("pattern must be a string");
  }
}

export function matchesPattern(pattern, topic) {
  assertPattern(pattern);
  assertTopic(topic);
  return pattern === topic;
}
