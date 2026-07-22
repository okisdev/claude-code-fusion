function hasValidSegments(value, permitsWildcard) {
  const segments = value.split(".");
  return segments.every((segment, index) => {
    if (segment.length === 0) {
      return false;
    }
    if (segment === "*") {
      return permitsWildcard && index === segments.length - 1;
    }
    return !segment.includes("*");
  });
}

export function assertTopic(topic) {
  if (typeof topic !== "string" || !hasValidSegments(topic, false)) {
    throw new TypeError("topic must be a valid topic");
  }
}

export function assertPattern(pattern) {
  if (typeof pattern !== "string" || !hasValidSegments(pattern, true)) {
    throw new TypeError("pattern must be a valid pattern");
  }
}

export function matchesPattern(pattern, topic) {
  assertPattern(pattern);
  assertTopic(topic);
  if (pattern === topic) {
    return true;
  }
  if (pattern === "*") {
    return !topic.includes(".");
  }
  if (!pattern.endsWith(".*")) {
    return false;
  }
  return topic.startsWith(pattern.slice(0, -1));
}
