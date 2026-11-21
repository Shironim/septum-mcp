import { WorkspaceBusyError } from "../errors.ts";
import { RESOURCE_LIMITS } from "./limits.ts";

/** One mutation/parse lane per server; failures do not poison later work. */
export class SerialWorkQueue {
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
