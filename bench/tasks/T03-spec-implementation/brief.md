# Event bus implementation

Implement the event bus described here in the fixture project. The package has no dependencies and uses native Node ESM.

The package entry point, `index.js`, must export the named exports `EventBus` and `matchesPattern`. Keep the implementation split between `match-pattern.js`, `subscriptions.js`, and `event-bus.js`; `index.js` only exposes the public API.

1. A topic is a nonempty string of dot separated segments. Each segment must be nonempty and must not contain `.` or `*`. A pattern follows the same rule except its final segment may be `*`. A pattern of `*` is valid. Reject every invalid topic or pattern with `TypeError`.
2. `matchesPattern(pattern, topic)` validates both arguments. It returns `true` for an exact match. A final `*` matches exactly one topic segment, so `orders.*` matches `orders.created` but not `orders.created.audit`, and `*` matches `ready` but not `system.ready`.
3. `new EventBus()` creates an empty bus. `subscribe(pattern, listener)` validates its pattern and requires a function listener, otherwise it throws `TypeError`. It returns an unsubscribe function. Calling that function removes only its registration and returns `true`; later calls return `false`. Separate registrations of the same listener are separate subscriptions.
4. `once(pattern, listener)` has the same validation and return contract as `subscribe`. Its listener is removed before it is called, so a listener that publishes the same topic recursively still runs only once.
5. `publish(topic, payload)` validates its topic, then synchronously calls every listener whose pattern matches. Listeners receive `(payload, topic)` and run in registration order across exact and wildcard patterns. It returns the number of listeners selected for the delivery.
6. A publish uses a snapshot of the matching registrations taken before the first listener runs. A listener that subscribes or unsubscribes during delivery does not change that delivery, but does affect later publishes. If a listener throws, `publish` propagates that error immediately and does not call later listeners.
