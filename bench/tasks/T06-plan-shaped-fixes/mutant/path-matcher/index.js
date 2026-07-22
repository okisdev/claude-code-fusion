export function matchesPath(pattern, candidate) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  const source = escaped.replaceAll("*", ".*");
  return new RegExp(`^${source}$`).test(candidate);
}
