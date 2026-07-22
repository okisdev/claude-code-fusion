import { format } from "./format.js";

export async function buildSummary(topic) {
  const value = await format(topic);
  return `Summary: ${value}`;
}
