/** A buffered invalidation, shared by the two existing core supervisors. */
export function createSupervisorWake(signal: AbortSignal) {
  let invalidated = true;
  let resume: (() => void) | undefined;
  const wake = () => {
    invalidated = true;
    resume?.();
  };
  signal.addEventListener('abort', wake, { once: true });
  return {
    wake,
    isInvalidated() { return invalidated; },
    reset() { invalidated = false; },
    async wait(clock: Readonly<{
      now(): number;
      sleep(delayMs: number, signal: AbortSignal): Promise<void>;
    }>, deadline?: number) {
      if (invalidated || signal.aborted) return;
      const timer = new AbortController();
      try {
        const changed = new Promise<void>(resolve => { resume = resolve; });
        if (invalidated || signal.aborted) resume?.();
        if (deadline === undefined) await changed;
        else {
          // Node and browser timers clamp larger delays to their signed 32-bit
          // range. Chunk the wait, not the owner's deadline or work cadence.
          const untilDeadline = async () => {
            while (!timer.signal.aborted && clock.now() < deadline) {
              await clock.sleep(Math.min(deadline - clock.now(), 2_147_483_647), timer.signal);
            }
          };
          await Promise.race([changed, untilDeadline()]);
        }
      } finally {
        resume = undefined;
        timer.abort();
      }
    },
    dispose() { signal.removeEventListener('abort', wake); },
  };
}
