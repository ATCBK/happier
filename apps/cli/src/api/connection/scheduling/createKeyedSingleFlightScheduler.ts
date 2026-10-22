export type KeyedSingleFlightScheduler = {
  scheduleResult: <T>(key: string, run: () => Promise<T>) => Promise<T>;
};

type DeferredResult = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type Entry = {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  queued: boolean;
  pendingRun: (() => Promise<void>) | null;
  result: DeferredResult | null;
};

export function createKeyedSingleFlightScheduler(params: Readonly<{ delayMs: number; maxConcurrent?: number }>): KeyedSingleFlightScheduler {
  const entries = new Map<string, Entry>();
  const readyQueue: string[] = [];
  const maxConcurrent = (() => {
    const value = params.maxConcurrent;
    if (typeof value !== 'number') return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
    return Math.max(1, Math.floor(value));
  })();
  let activeCount = 0;

  function getOrCreateEntry(key: string): Entry {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: Entry = { timer: null, inFlight: null, queued: false, pendingRun: null, result: null };
    entries.set(key, created);
    return created;
  }

  function createDeferredResult(): DeferredResult {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function maybeDeleteEntry(key: string, entry: Entry): void {
    if (entry.timer) return;
    if (entry.inFlight) return;
    if (entry.queued) return;
    if (entry.pendingRun) return;
    entries.delete(key);
  }

  function drainQueue(): void {
    while (activeCount < maxConcurrent && readyQueue.length > 0) {
      const key = readyQueue.shift();
      if (!key) continue;
      const entry = entries.get(key);
      if (!entry) continue;
      entry.queued = false;
      if (entry.timer || entry.inFlight || !entry.pendingRun) {
        maybeDeleteEntry(key, entry);
        continue;
      }
      startRunIfCapacity(key, entry);
    }
  }

  function startRunIfCapacity(key: string, entry: Entry): void {
    if (entry.inFlight) return;
    const run = entry.pendingRun;
    if (!run) {
      maybeDeleteEntry(key, entry);
      return;
    }

    if (activeCount >= maxConcurrent) {
      if (!entry.queued) {
        entry.queued = true;
        readyQueue.push(key);
      }
      return;
    }

    entry.pendingRun = null;
    activeCount += 1;
    // The result wrapper settles every borrower's promise, including failures.
    const pending = (async () => { await run(); })();
    entry.inFlight = pending.finally(() => {
      activeCount -= 1;
      entry.inFlight = null;
      entry.result = null;
      maybeDeleteEntry(key, entry);
      drainQueue();
    });
  }

  return {
    scheduleResult(key, run) {
      if (!key) return Promise.reject(new Error('Scheduler key is required'));
      const entry = getOrCreateEntry(key);
      if (entry.result) return entry.result.promise as Promise<Awaited<ReturnType<typeof run>>>;
      const result = createDeferredResult();
      entry.result = result;
      entry.pendingRun = async () => {
        try {
          result.resolve(await run());
        } catch (error) {
          result.reject(error);
        }
      };
      entry.timer = setTimeout(() => {
        entry.timer = null;
        startRunIfCapacity(key, entry);
      }, params.delayMs);
      entry.timer.unref?.();
      return result.promise as Promise<Awaited<ReturnType<typeof run>>>;
    },
  };
}
