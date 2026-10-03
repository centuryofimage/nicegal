/** Session history with the browser's ordering: push/replace are immediate, traversals land
 * (and dispatch popstate) only on `flush()`. */
export class FakeHistory {
  entries: unknown[] = [null];
  index = 0;
  #queued: number[] = [];
  #listeners = new Set<() => void>();

  get state(): unknown {
    return this.entries[this.index];
  }
  get length(): number {
    return this.entries.length;
  }
  pushState(state: unknown): void {
    this.entries.splice(this.index + 1, Infinity, state);
    this.index++;
  }
  replaceState(state: unknown): void {
    this.entries[this.index] = state;
  }
  go(delta: number): void {
    this.#queued.push(delta);
  }
  back(): void {
    this.go(-1);
  }
  addEventListener(_type: "popstate", listener: () => void): void {
    this.#listeners.add(listener);
  }
  removeEventListener(_type: "popstate", listener: () => void): void {
    this.#listeners.delete(listener);
  }
  /** Lands queued traversals in order, as the browser's task queue would. */
  flush(): void {
    while (this.#queued.length) {
      const target = this.index + this.#queued.shift()!;
      if (target < 0 || target >= this.entries.length || target === this.index) continue;
      this.index = target;
      for (const listener of this.#listeners) listener();
    }
  }
}
