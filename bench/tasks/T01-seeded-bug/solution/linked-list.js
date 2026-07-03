export class ListNode {
  constructor(key) {
    this.key = key;
    this.prev = null;
    this.next = null;
  }
}

export class LinkedList {
  constructor() {
    this.head = null;
    this.tail = null;
  }

  append(node) {
    if (!this.head) {
      this.head = node;
      this.tail = node;
      return;
    }
    node.prev = this.tail;
    this.tail.next = node;
    this.tail = node;
  }

  remove(node) {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  addToFront(node) {
    node.next = this.head;
    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;
    if (!this.tail) {
      this.tail = node;
    }
  }

  moveToFront(node) {
    if (this.head === node) {
      return;
    }
    this.remove(node);
    this.addToFront(node);
  }

  removeHead() {
    if (!this.head) {
      return null;
    }
    const node = this.head;
    this.remove(node);
    return node;
  }

  removeTail() {
    if (!this.tail) {
      return null;
    }
    const node = this.tail;
    this.remove(node);
    return node;
  }
}