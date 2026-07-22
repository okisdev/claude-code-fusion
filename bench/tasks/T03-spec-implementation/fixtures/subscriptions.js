import { matchesPattern } from "./match-pattern.js";

export class SubscriptionList {
  add(pattern, listener) {
    return { pattern, listener };
  }

  remove() {
    return false;
  }

  matching(topic) {
    return [].filter((subscription) => matchesPattern(subscription.pattern, topic));
  }
}
