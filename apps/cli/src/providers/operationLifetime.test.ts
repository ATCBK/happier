import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, it, vi } from 'vitest';
import { awaitAbortableWithinProviderOperation, createProviderOperationLifetime } from './operationLifetime';

it.each([false, true])('keeps an uncapped containing operation cancellable after a slow admission (cancel=%s)', async cancelled => {
  vi.useFakeTimers();
  const caller = new AbortController();
  let finish = () => {};
  const response = new Promise<string>(resolve => { finish = () => resolve('admitted'); });
  const result = awaitAbortableWithinProviderOperation(signal => {
    // A real cancelled transport may settle successfully during its abort
    // callback. Cancellation must still win over that withdrawal settlement.
    signal.addEventListener('abort', finish, { once: true });
    return response;
  },
    createProviderOperationLifetime({ signal: caller.signal }));
  // Install the rejection observer before cancellation can settle the race.
  const observed = result.then(value => ({ value }), error => ({ reason: error.reason }));
  try {
    await vi.advanceTimersByTimeAsync(35_000);
    if (cancelled) caller.abort();
    else finish();
    expect(await observed).toEqual(cancelled ? { reason: 'cancelled' } : { value: 'admitted' });
  } finally {
    finish();
    await observed;
    vi.useRealTimers();
  }
});

it.each(['deadline', 'cancelled'] as const)('settles an already abandoned %s without an unhandled transport rejection', reason => {
  // Observe Node's actual rejection boundary in an isolated process: the daemon
  // treats this event as fatal, while Vitest intercepts it in its own process.
  const modulePath = fileURLToPath(new URL('./operationLifetime.ts', import.meta.url));
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { pathToFileURL } from 'node:url';
    const { awaitAbortableWithinProviderOperation } = await import(pathToFileURL(process.argv[1]).href);
    const reason = process.argv[2];
    const caller = new AbortController();
    if (reason === 'cancelled') caller.abort();
    const unhandled = [];
    process.on('unhandledRejection', error => unhandled.push(error.name));
    let refusal;
    try {
      await awaitAbortableWithinProviderOperation(async signal => {
        signal.throwIfAborted();
        return await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }, { signal: caller.signal, wallDeadlineAtMs: Date.now() + (reason === 'deadline' ? -1 : 30000) });
    } catch (error) { refusal = error.reason; }
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({ refusal, unhandled }));
  `, modulePath, reason], { encoding: 'utf8' });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ refusal: reason, unhandled: [] });
});
