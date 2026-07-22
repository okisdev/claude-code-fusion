import { matchesPattern } from "./match-pattern.js";

export class SubscriptionList {
  #subscriptions = [];

  add(pattern, listener) {
    const subscription = { pattern, listener, active: true };
    this.#subscriptions.push(subscription);
    return subscription;
  }

  remove(subscription) {
    if (!subscription.active) {
      return false;
    }
    subscription.active = false;
    const index = this.#subscriptions.indexOf(subscription);
    if (index !== -1) {
      this.#subscriptions.splice(index, 1);
    }
    return true;
  }

  matching(topic) {
    return this.#subscriptions.filter(
      (subscription) => subscription.active && matchesPattern(subscription.pattern, topic),
    );
  }
}
