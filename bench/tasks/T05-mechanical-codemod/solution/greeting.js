import { format } from "./format.js";

export async function buildGreeting(name) {
  const value = await format(name);
  return `Hello, ${value}!`;
}
