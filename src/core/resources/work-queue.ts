import { WorkspaceBusyError } from "../errors.ts";
import { RESOURCE_LIMITS } from "./limits.ts";

export interface WorkQueue {
  readonly pendingCount: number;
  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  drain(): Promise<void>;
}

/** One mutation/parse lane per server; failures do not poison later work. */
export class SerialWorkQueue implements WorkQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly maxPending: number;

  constructor(maxPending = RESOURCE_LIMITS.maxQueuePending) {
    this.maxPending = maxPending;
  }

  get pendingCount(): number {
    return this.pending;
  }

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Request was cancelled before queueing"));
    }

    if (this.pending >= this.maxPending) {
      return Promise.reject(
        new WorkspaceBusyError(`Server is busy: request admission limit (${this.maxPending}) exceeded. Retry after current tasks finish.`)
      );
    }

    this.pending++;

    return new Promise<T>((resolve, reject) => {
      let cancelled = false;

      const abortHandler = () => {
        cancelled = true;
        reject(signal?.reason ?? new Error("Request was cancelled while queued"));
      };

      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      const execute = async () => {
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        if (cancelled || signal?.aborted) {
          if (!cancelled) {
            reject(signal?.reason ?? new Error("Request was cancelled before execution"));
          }
          return;
        }

        try {
          const res = await work();
          resolve(res);
        } catch (err) {
          reject(err);
        }
      };

      const next = this.tail.then(execute, execute);
      this.tail = next.finally(() => {
        this.pending--;
        if (this.pending === 0) {
          this.tail = Promise.resolve();
        }
      });
    });
  }

  drain(): Promise<void> {
    return this.tail;
  }
}

/** Per-workspace reader/writer queue: concurrent readers, exclusive writers, FIFO fairness. */
export class ReadWriteWorkQueue implements WorkQueue {
  private activeReaders = 0;
  private activeWriter = false;
  private waiters: Array<{ mode: "read" | "write"; start: () => void }> = [];
  private drainResolvers: Array<() => void> = [];
  private readonly maxPending: number;

  constructor(maxPending = RESOURCE_LIMITS.maxQueuePending) {
    this.maxPending = maxPending;
  }

  get pendingCount(): number {
    return this.waiters.length + this.activeReaders + (this.activeWriter ? 1 : 0);
  }

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.runWrite(work, signal);
  }

  runRead<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue("read", work, signal);
  }

  runWrite<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue("write", work, signal);
  }

  private enqueue<T>(mode: "read" | "write", work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Request was cancelled before queueing"));
    }

    if (this.pendingCount >= this.maxPending) {
      return Promise.reject(
        new WorkspaceBusyError(`Server is busy: request admission limit (${this.maxPending}) exceeded. Retry after current tasks finish.`)
      );
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let started = false;

      const execute = async () => {
        started = true;
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        if (settled || signal?.aborted) {
          if (!settled) {
            settled = true;
            reject(signal?.reason ?? new Error("Request was cancelled before execution"));
          }
          this.release(mode);
          return;
        }
        try {
          const res = await work();
          if (!settled) {
            settled = true;
            resolve(res);
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
        } finally {
          this.release(mode);
        }
      };

      const waiter = { mode, start: () => { void execute(); } };

      const abortHandler = () => {
        if (started || settled) return;
        settled = true;
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(signal?.reason ?? new Error("Request was cancelled while queued"));
        this.scheduleNext();
      };

      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      if (mode === "read" && !this.activeWriter && this.waiters.length === 0) {
        this.activeReaders++;
        void execute();
      } else if (mode === "write" && !this.activeWriter && this.activeReaders === 0 && this.waiters.length === 0) {
        this.activeWriter = true;
        void execute();
      } else {
        this.waiters.push(waiter);
      }
    });
  }

  private release(mode: "read" | "write"): void {
    if (mode === "read") {
      this.activeReaders = Math.max(0, this.activeReaders - 1);
    } else {
      this.activeWriter = false;
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (!this.activeWriter && this.waiters.length > 0) {
      if (this.waiters[0]!.mode === "write") {
        if (this.activeReaders === 0) {
          const next = this.waiters.shift()!;
          this.activeWriter = true;
          next.start();
        }
      } else {
        while (this.waiters.length > 0 && this.waiters[0]!.mode === "read") {
          const next = this.waiters.shift()!;
          this.activeReaders++;
          next.start();
        }
      }
    }

    if (!this.activeWriter && this.activeReaders === 0 && this.waiters.length === 0) {
      const resolvers = this.drainResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  drain(): Promise<void> {
    if (!this.activeWriter && this.activeReaders === 0 && this.waiters.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }
}

// A requester can stop waiting without cancelling work owned by a workspace.
export function waitForSharedWork<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      detach();
      reject(signal.reason);
    };
    const detach = () => signal.removeEventListener("abort", abort);
    work.then(value => { detach(); resolve(value); }, error => { detach(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
