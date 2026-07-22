import { format } from "./format.js";

export async function buildAlert(message) {
  const value = await format(message);
  return `Alert: ${value.toUpperCase()}`;
}
