import { format } from "./format.js";

export async function buildDigest(period) {
  const value = await format(period);
  return `Digest: ${value.toLowerCase()}`;
}
