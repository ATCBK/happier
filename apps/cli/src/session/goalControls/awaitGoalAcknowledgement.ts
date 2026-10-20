import { throwIfAborted } from '@happier-dev/plugin-sdk/async';

export async function awaitGoalAcknowledgement<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return await operation();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // Cancellation retires only this caller's receipt. An admitted native
    // effect keeps its own publication/custody and may finish after detachment.
    const result = await Promise.race([cancelled, Promise.resolve().then(() => {
      throwIfAborted(signal);
      return operation();
    })]);
    throwIfAborted(signal);
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
