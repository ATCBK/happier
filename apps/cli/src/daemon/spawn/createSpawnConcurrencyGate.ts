export type SpawnConcurrencyGate = Readonly<{
  run: <T>(work: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}>;

export function createSpawnConcurrencyGate(maxConcurrent: number): SpawnConcurrencyGate {
  // `0` means "unlimited": spawning sessions is a first-class flow and should not be capped unless
  // an operator explicitly configures a limit via env.
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 0) {
    throw new Error(`Invalid maxConcurrent: ${maxConcurrent}`);
  }

  if (maxConcurrent === 0) {
    return {
      run: async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
        signal?.throwIfAborted();
        return await work();
      },
    };
  }

  let inFlight = 0;
  const queue: Array<() => void> = [];

  const acquire = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (inFlight < maxConcurrent) {
      inFlight += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        const index = queue.indexOf(grant);
        if (index < 0) return;
        queue.splice(index, 1);
        signal?.removeEventListener('abort', cancel);
        reject(signal?.reason);
      };
      queue.push(grant);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });

    // Slot is transferred directly from the releasing worker to this waiter.
    // (No inFlight change here.)
  };

  const release = (): void => {
    const next = queue.shift();
    if (next) {
      // Keep inFlight unchanged; we transfer the slot to the next waiter.
      next();
      return;
    }

    inFlight = Math.max(0, inFlight - 1);
  };

  return {
    run: async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
      await acquire(signal);
      try {
        signal?.throwIfAborted();
        return await work();
      } finally {
        release();
      }
    },
  };
}
