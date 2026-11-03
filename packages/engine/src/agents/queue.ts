// A small async queue: producers push events, one consumer iterates until end().
export class EventQueue<T> {
  private readonly items: T[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return;
    this.items.push(item);
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  get ended(): boolean {
    return this.done;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }
}
