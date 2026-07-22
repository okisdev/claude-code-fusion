function compareParsedVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] < right[key]) {
      return -1;
    }
    if (left[key] > right[key]) {
      return 1;
    }
  }
  return 0;
}

function parseRangeVersion(input) {
  return parseVersion(input);
}

function testComparator(version, operator, bound) {
  const comparison = compareParsedVersions(version, bound);
  if (operator === ">") {
    return comparison > 0;
  }
  if (operator === ">=") {
    return comparison >= 0;
  }
  if (operator === "<") {
    return comparison < 0;
  }
  if (operator === "<=") {
    return comparison <= 0;
  }
  return comparison === 0;
}

function incrementComponent(version, key) {
  if (version[key] === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("range upper bound is unsafe");
  }
  const upper = { major: version.major, minor: version.minor, patch: version.patch };
  upper[key] += 1;
  if (key === "major") {
    upper.minor = 0;
    upper.patch = 0;
  } else if (key === "minor") {
    upper.patch = 0;
  }
  return upper;
}

export function parseVersion(input) {
  if (typeof input !== "string") {
    throw new TypeError("version must be a string");
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(input);
  if (!match) {
    throw new RangeError("version must use MAJOR.MINOR.PATCH");
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new RangeError("version components must be safe integers");
  }
  return { major, minor, patch };
}

export function compareVersions(left, right) {
  return compareParsedVersions(parseVersion(left), parseVersion(right));
}

export function satisfiesRange(version, range) {
  const parsedVersion = parseVersion(version);
  if (typeof range !== "string") {
    throw new TypeError("range must be a string");
  }
  const trimmed = range.trim();
  if (trimmed === "") {
    throw new RangeError("range must not be empty");
  }
  if (trimmed === "*") {
    return true;
  }

  return trimmed.split(/\s+/).every((part) => {
    if (part.startsWith("^")) {
      const lower = parseRangeVersion(part.slice(1));
      const upper = incrementComponent(lower, lower.major > 0 ? "major" : lower.minor > 0 ? "minor" : "patch");
      return testComparator(parsedVersion, ">=", lower) && testComparator(parsedVersion, "<", upper);
    }
    if (part.startsWith("~")) {
      const lower = parseRangeVersion(part.slice(1));
      const upper = incrementComponent(lower, "minor");
      return testComparator(parsedVersion, ">=", lower) && testComparator(parsedVersion, "<", upper);
    }
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
    if (!match) {
      throw new RangeError("range comparator is invalid");
    }
    return testComparator(parsedVersion, match[1] ?? "=", parseRangeVersion(match[2]));
  });
}
