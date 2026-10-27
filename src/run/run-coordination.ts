export class RunCoordination {
  readonly controller: AbortController;
  private readonly pending = new Set<symbol>();
  private readonly waiting = new Set<() => void>();

  constructor(controller: AbortController) {
    this.controller = controller;
    controller.signal.addEventListener("abort", () => this.wake(), {
      once: true,
    });
  }

  intervene(): () => void {
    const entry = Symbol();
    this.pending.add(entry);
    return () => {
      if (!this.pending.delete(entry)) return;
      if (this.pending.size === 0) this.wake();
    };
  }

  private wake(): void {
    for (const resolve of this.waiting) resolve();
    this.waiting.clear();
  }

  async advance<T>(action: () => Promise<T>): Promise<T> {
    while (this.pending.size > 0 && !this.controller.signal.aborted)
      await new Promise<void>((resolve) => this.waiting.add(resolve));
    this.controller.signal.throwIfAborted();
    return action();
  }
}
