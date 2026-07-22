import { format } from "./format.js";

export async function buildInvite(event) {
  const value = await format(event);
  return `Invite: ${value}`;
}
