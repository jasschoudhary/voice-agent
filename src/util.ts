/**
 * Small async utilities.
 */

import type WebSocket from 'ws';

/**
 * Unbounded async queue -- the Node equivalent of Python's asyncio.Queue.
 *
 * Every event source (Twilio socket, Flux callbacks, agent done-callback)
 * pushes into one queue and the conversation loop consumes one event at a
 * time. That single consumer is what serializes all state machine decisions.
 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  /** Add an item; wakes the oldest waiting get() if any. */
  put(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  /** Remove and return the next item, waiting until one is available. */
  get(): Promise<T> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift()!);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve when a ws client connection opens; reject if it errors first. */
export function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = (): void => {
      ws.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      ws.off('open', onOpen);
      reject(err);
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}
