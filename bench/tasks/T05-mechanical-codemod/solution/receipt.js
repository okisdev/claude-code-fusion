import { format } from "./format.js";

export async function buildReceipt(order) {
  const value = await format(order);
  return `Receipt: ${value}`;
}
