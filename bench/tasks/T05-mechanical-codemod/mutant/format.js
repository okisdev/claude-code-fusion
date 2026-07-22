function normalize(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

export function formatWithCallback(value, callback) {
  queueMicrotask(() => callback(normalize(value)));
}

export function format(value) {
  return Promise.resolve(normalize(value));
}
