import { storage } from '@/sync/domains/state/storage';

import { resolveSocketErrorClassification } from './resolveSocketErrorClassification';

/** Projects the primary socket's error/recovery channel into the shared realtime state. */
export function bindSocketErrorToRealtimeStore(
    subscribe: (listener: (error: Error | null) => void) => () => void,
): () => void {
    return subscribe((error) => {
        if (!error) {
            storage.getState().setSocketError(null);
            // A successful socket connection supersedes only this producer's error.
            // A sync operation may have published a different failure in the meantime.
            if (storage.getState().syncError?.source === 'socket') {
                storage.getState().clearSyncError();
            }
            return;
        }
        const message = error.message || 'Connection error';
        storage.getState().setSocketError(message);
        const classification = resolveSocketErrorClassification(error);
        storage.getState().setSyncError({
            message,
            retryable: classification.retryable,
            kind: classification.kind,
            at: Date.now(),
            source: 'socket',
        });
    });
}
