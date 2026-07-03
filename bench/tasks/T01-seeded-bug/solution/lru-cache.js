import { LinkedList, ListNode } from "./linked-list.js";

export class TtlLruCache {
  constructor({ maxSize = 16, defaultTtlMs = 0 } = {}) {
    if (maxSize < 1) {
      throw new RangeError("maxSize must be at least 1");
    }
    this.maxSize = maxSize;
    this.defaultTtlMs = defaultTtlMs;
    this.entries = new Map();
    this.order = new LinkedList();
    this.nodes = new Map();
  }

  get size() {
    return this.entries.size;
  }

  has(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    if (this.#isExpired(entry)) {
      this.delete(key);
      return false;
    }
    return true;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (this.#isExpired(entry)) {
      this.delete(key);
      return undefined;
    }
    const node = this.nodes.get(key);
    this.order.moveToFront(node);
    return entry.value;
  }

  set(key, value, options = {}) {
    const ttlMs =
      options.ttlMs === undefined ? this.defaultTtlMs : options.ttlMs;
    const expiresAt =
      ttlMs > 0 ? Date.now() + ttlMs : Number.POSITIVE_INFINITY;

    const existing = this.entries.get(key);
    if (existing) {
      existing.value = value;
      existing.expiresAt = expiresAt;
      this.order.moveToFront(this.nodes.get(key));
      return;
    }

    while (this.entries.size >= this.maxSize) {
      const evicted = this.order.removeTail();
      if (!evicted) {
        break;
      }
      this.#dropKey(evicted.key);
    }

    const node = new ListNode(key);
    this.nodes.set(key, node);
    this.order.addToFront(node);
    this.entries.set(key, { value, expiresAt });
  }

  delete(key) {
    const node = this.nodes.get(key);
    if (!node) {
      return false;
    }
    this.#dropKey(key);
    return true;
  }

  clear() {
    this.entries.clear();
    this.order = new LinkedList();
    this.nodes.clear();
  }

  #dropKey(key) {
    const node = this.nodes.get(key);
    if (node) {
      this.order.remove(node);
      this.nodes.delete(key);
    }
    this.entries.delete(key);
  }

  #isExpired(entry) {
    return entry.expiresAt <= Date.now();
  }
}