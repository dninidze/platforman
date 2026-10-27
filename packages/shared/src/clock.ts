/**
 * Clock abstraction so the round engine can be driven by real timers in production and by a
 * deterministic fake clock in tests and the simulator.
 */
export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | null | undefined): void;
}

export class RealClock implements Clock {
  private next = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  now(): number {
    return Date.now();
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.next++;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        fn();
      }, Math.max(0, ms)),
    );
    return { id };
  }
  clearTimeout(h: TimerHandle | null | undefined): void {
    if (!h) return;
    const t = this.timers.get(h.id);
    if (t) clearTimeout(t);
    this.timers.delete(h.id);
  }
  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.next++;
    this.timers.set(id, setInterval(fn, ms) as unknown as ReturnType<typeof setTimeout>);
    return { id };
  }
  clearInterval(h: TimerHandle | null | undefined): void {
    if (!h) return;
    const t = this.timers.get(h.id);
    if (t) clearInterval(t as unknown as ReturnType<typeof setInterval>);
    this.timers.delete(h.id);
  }
}

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
  every: number | null;
  order: number;
}

/** Deterministic clock: time only moves when advance()/advanceTo() is called. */
export class FakeClock implements Clock {
  private t: number;
  private nextId = 1;
  private order = 0;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(start = 1_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, Math.max(0, ms), null);
  }
  setInterval(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, Math.max(1, ms), Math.max(1, ms));
  }
  clearTimeout(h: TimerHandle | null | undefined): void {
    if (h) this.timers.delete(h.id);
  }
  clearInterval(h: TimerHandle | null | undefined): void {
    if (h) this.timers.delete(h.id);
  }

  /** Move time forward, firing due timers in time order (ties in creation order). */
  advance(ms: number): void {
    this.advanceTo(this.t + ms);
  }

  advanceTo(target: number): void {
    for (;;) {
      let due: FakeTimer | null = null;
      for (const tm of this.timers.values()) {
        if (tm.at <= target && (!due || tm.at < due.at || (tm.at === due.at && tm.order < due.order))) due = tm;
      }
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      if (due.every !== null) {
        due.at += due.every;
        due.order = this.order++;
      } else {
        this.timers.delete(due.id);
      }
      due.fn();
    }
    this.t = Math.max(this.t, target);
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  private add(fn: () => void, ms: number, every: number | null): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.t + ms, fn, every, order: this.order++ });
    return { id };
  }
}
