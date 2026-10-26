import { useSyncExternalStore } from 'react';

/** A minimal observable value. The engine publishes UI snapshots a few times a second; React subscribes. */
export class Store<T> {
  private value: T;
  private readonly subs = new Set<() => void>();

  constructor(value: T) {
    this.value = value;
  }

  get = (): T => this.value;

  set(value: T) {
    this.value = value;
    for (const fn of this.subs) fn();
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
