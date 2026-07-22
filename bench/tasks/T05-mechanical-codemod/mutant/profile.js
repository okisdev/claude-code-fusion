import { format } from "./format.js";

export async function buildProfile(name) {
  const value = await format(name);
  return `Profile: ${value}`;
}
