function decodePart(value) {
  return decodeURIComponent(value.replace(/\+/g, " "));
}

function encodePart(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, "+");
}

export function parseQuery(input) {
  if (typeof input !== "string") {
    throw new TypeError("input must be a string");
  }

  const result = Object.create(null);
  const query = (input.startsWith("?") ? input.slice(1) : input).split("#", 1)[0];
  for (const segment of query.split("&")) {
    if (segment === "") {
      continue;
    }
    const separator = segment.indexOf("=");
    const key = decodePart(separator === -1 ? segment : segment.slice(0, separator));
    const value = decodePart(separator === -1 ? "" : segment.slice(separator + 1));
    if (!Object.hasOwn(result, key)) {
      result[key] = value;
    } else if (Array.isArray(result[key])) {
      result[key].push(value);
    } else {
      result[key] = [result[key], value];
    }
  }
  return result;
}

export function stringifyQuery(values) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("values must be an object");
  }

  const pairs = [];
  for (const key of Object.keys(values)) {
    const entries = Array.isArray(values[key]) ? values[key] : [values[key]];
    for (const entry of entries) {
      if (entry === undefined) {
        continue;
      }
      pairs.push(`${encodePart(key)}=${encodePart(entry === null ? "" : entry)}`);
    }
  }
  return pairs.join("&");
}
