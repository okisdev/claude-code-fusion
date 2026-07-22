import { formatWithCallback } from "./format.js";

export function buildInvite(event) {
  return new Promise((resolve) => {
    formatWithCallback(event, (value) => {
      resolve(`Invite: ${value}`);
    });
  });
}
