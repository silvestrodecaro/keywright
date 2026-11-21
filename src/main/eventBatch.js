'use strict';

/**
 * Collects items and delivers them together after `delayMs`, so a burst (a Robot run
 * logging thousands of messages) becomes a few IPC messages instead of one per item.
 */
class Batch {
  /** @param {(items: unknown[]) => void} deliver  @param {number} delayMs */
  constructor(deliver, delayMs = 50) {
    this._deliver = deliver;
    this._delay = delayMs;
    this._items = [];
    this._timer = null;
  }

  push(item) {
    this._items.push(item);
    if (!this._timer)
      this._timer = setTimeout(() => this.flush(), this._delay);
  }

  /** Delivers what is waiting now (before a message that must come after it). */
  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._items.length)
      return;
    const items = this._items;
    this._items = [];
    this._deliver(items);
  }
}

module.exports = { Batch };
