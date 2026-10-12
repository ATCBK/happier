import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_DELIVERIES_INDEX_ID,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
} from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';

/** An empty Account has no ingress, delivery, deletion or retention work to reconcile. */
export async function waitForChannelsAccountRows(context: BackgroundServiceContext): Promise<void> {
  const observations: Array<{ dispose(): void }> = [];
  let invalidated = false;
  let wake: (() => void) | undefined;
  const notify = () => { invalidated = true; wake?.(); };
  context.signal.addEventListener('abort', notify, { once: true });
  try {
    if (context.signal.aborted) return;
    const account = requireChannelsAccountStorage(context);
    const state = account.collection(CHANNEL_STATE_COLLECTION);
    const deliveries = account.collection(CHANNEL_DELIVERIES_COLLECTION);
    const hasRows = async () => {
      const pages = await Promise.all([
        state.query({ index: CHANNEL_STATE_INDEX_ID.byKind, order: 'asc', limit: 1 }, { signal: context.signal }),
        deliveries.query({ index: CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention, order: 'asc', limit: 1 }, { signal: context.signal }),
      ]);
      return pages.some(page => page.rows.length > 0 || page.nextCursor !== undefined);
    };
    if (await hasRows() || context.signal.aborted) return;
    // The initial reads supply the host watch's starting AccountChange cursors.
    // Its buffered invalidation covers query-to-registration; the second read
    // also covers a synchronous registration wake before this waiter is armed.
    observations.push(state.watch({ kind: 'collection' }, notify));
    observations.push(deliveries.watch({ kind: 'collection' }, notify));
    while (!context.signal.aborted) {
      invalidated = false;
      if (await hasRows() || context.signal.aborted) return;
      if (invalidated) continue;
      await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
    }
  } catch {
    if (!context.signal.aborted) {
      // An unavailable census proves no absence. Preserve the existing active
      // supervisor's fail-closed storage reads and retry/recovery behavior.
      context.services.logger.warn('[Channels] initial Account work census unavailable');
    }
  } finally {
    context.signal.removeEventListener('abort', notify);
    for (const observation of observations) observation.dispose();
  }
}
