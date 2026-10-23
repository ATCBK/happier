import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';

/**
 * Read placement history at folder-selection intent. The always-mounted composer
 * needs initial hydration, while only an open picker or an unresolved default
 * needs live history publications. No Session snapshots are retained here.
 */
export function useNewSessionPlacementSessions(subscribeToHistory = false): () => Session[] | null {
    const ready = storage(state => state.isDataReady);
    const demandedSessions = storage(state => subscribeToHistory && state.isDataReady ? state.sessions : null);
    return React.useCallback(() => {
        const state = storage.getState();
        return state.isDataReady ? Object.values(state.sessions) : null;
    }, [ready, demandedSessions]);
}
