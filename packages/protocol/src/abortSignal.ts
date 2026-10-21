/** AbortSignal convenience methods are not available in every key-holding host. */
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
}
