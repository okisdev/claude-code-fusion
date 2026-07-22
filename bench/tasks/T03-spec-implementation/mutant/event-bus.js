import { assertPattern, assertTopic } from "./match-pattern.js";
import { SubscriptionList } from "./subscriptions.js";

function assertListener(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("listener must be a function");
  }
}

export class EventBus {
  #subscriptions = new SubscriptionList();

  subscribe(pattern, listener) {
    assertPattern(pattern);
    assertListener(listener);
    const subscription = this.#subscriptions.add(pattern, listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return false;
      }
      subscribed = false;
      return this.#subscriptions.remove(subscription);
    };
  }

  once(pattern, listener) {
    assertPattern(pattern);
    assertListener(listener);
    let unsubscribe;
    const wrappedListener = (payload, topic) => {
      unsubscribe();
      listener(payload, topic);
    };
    unsubscribe = this.subscribe(pattern, wrappedListener);
    return unsubscribe;
  }

  publish(topic, payload) {
    assertTopic(topic);
    const subscriptions = this.#subscriptions.matching(topic);
    for (const subscription of subscriptions) {
      subscription.listener(payload, topic);
    }
    return subscriptions.length;
  }
}
