import { waitForTestEvent } from '@/dev/testkit';

/** Actual diagnostics RPC and committed status publications, without a polling clock. */
export function createDiagnosticsTestEvents() {
  const listeners = new Set<() => void>();
  const subscribe = (notify: () => void) => {
    listeners.add(notify);
    return () => { listeners.delete(notify); };
  };
  return {
    notify() {
      for (const listener of listeners) listener();
    },
    clear() { listeners.clear(); },
    async waitFor(assertion: () => void) {
      await waitForTestEvent(subscribe, assertion);
    },
  };
}
