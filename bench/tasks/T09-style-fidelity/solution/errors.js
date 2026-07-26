export function app_error(code, message) {
  const error = new globalThis.Error(message);
  error.code = `E_${code}`;
  return error;
}
