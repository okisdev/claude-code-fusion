import { format } from "./format.js";

export async function buildStatus(status) {
  const value = await format(status);
  return `Status: ${value.toUpperCase()}`;
}
