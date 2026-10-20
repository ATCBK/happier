import type { DestinationInstanceTitleEntry } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { DocumentTabPresentation } from '@/components/ui/navigation/DocumentTabStrip';
import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { storage } from '@/sync/domains/state/storageStore';
import { presentSessionAwarenessV1, readSessionStatusLifecycleState, readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';

/** Tab chrome consumes the same Home-scoped summary and awareness answer as Session rows. */
export function useDestinationInstanceTabPresentations(entries: readonly DestinationInstanceTitleEntry[]): ReadonlyMap<string, DocumentTabPresentation> {
    const sessionEntries = React.useMemo(() => entries.filter((entry) => entry.ref.kind === 'session'), [entries]);
    const activeServer = useActiveServerSnapshot(sessionEntries.some((entry) => !entry.ref.params.serverId));
    const rows = storage(useShallow((state) => sessionEntries.map((entry) => readSessionListRowForServerId(
        state.sessionListRowsByServerId,
        entry.ref.params.serverId || activeServer.serverId,
        entry.ref.params.id,
    ))));
    const nowMs = useSessionListRuntimeNowMs(sessionEntries.length > 0);
    let nextWakeAtMs: number | null = null;
    const presentations = new Map<string, DocumentTabPresentation>();
    rows.forEach((row, index) => {
        if (!row) return;
        const refreshAtMs = readSessionStatusNextRefreshAtMs(row, nowMs);
        if (refreshAtMs !== null) nextWakeAtMs = nextWakeAtMs === null ? refreshAtMs : Math.min(nextWakeAtMs, refreshAtMs);
        const presentation = presentSessionAwarenessV1(projectUiSessionAwareness(row, nowMs), {
            lifecycleState: readSessionStatusLifecycleState(row), disconnectedTextMode: 'offline',
        });
        let tone: NonNullable<DocumentTabPresentation['status']>['tone'];
        switch (presentation.state) {
            case 'thinking':
            case 'resuming': tone = 'working'; break;
            case 'permission_required':
            case 'action_required': tone = 'attention'; break;
            case 'failed': tone = 'failed'; break;
            case 'disconnected':
            case 'recoverable_unservable': tone = 'offline'; break;
            default: return;
        }
        presentations.set(sessionEntries[index].key, { status: { tone, label: presentation.statusText } });
    });
    useSessionListRuntimeWake(nextWakeAtMs, sessionEntries.length > 0);

    // Clock wakes and unrelated summary changes must not churn tab props when chrome is unchanged.
    const previous = React.useRef<ReadonlyMap<string, DocumentTabPresentation>>(new Map());
    if (previous.current.size !== presentations.size || [...presentations].some(([key, value]) => {
        const oldStatus = previous.current.get(key)?.status;
        return oldStatus?.tone !== value.status?.tone || oldStatus?.label !== value.status?.label;
    })) previous.current = presentations;
    return previous.current;
}
