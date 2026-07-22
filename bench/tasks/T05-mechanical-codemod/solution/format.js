function normalize(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

export function format(value) {
  return Promise.resolve(normalize(value));
}
