import * as React from 'react';
import type { WorkerUpdateV1 } from '@happier-dev/protocol';
import type { Message } from '@happier-dev/session-core/messages';

import { getStorage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useSessionTranscriptSource } from './SessionTranscriptSourceContext';

function latestWorkerUpdateMessageId(messages: readonly Message[], worker: WorkerUpdateV1): string | null {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.kind !== 'agent-event' || message.event.type !== 'worker-update') continue;
        const update = message.event.update;
        if (update.workerKind === worker.workerKind && update.workerId === worker.workerId) return message.id;
    }
    return null;
}

/** Historical notices keep their result; only the latest notice in this exact transcript owns live answers. A null message reads nothing. */
export function useCurrentWorkerUpdate(update: WorkerUpdateV1, messageId: string | null, serverId: string | null | undefined): boolean {
    const source = useSessionTranscriptSource();
    const history = source.history.useState();
    const sameHome = areServerProfileIdentifiersEquivalent(source.serverId, serverId);
    if (source.kind !== 'app') {
        const ids = source.useMessageIdsOldestFirst();
        const byId = source.useMessagesById();
        return messageId !== null && sameHome && !history.hasNewer
            && latestWorkerUpdateMessageId(ids.flatMap(id => byId[id] ? [byId[id]] : []), update) === messageId;
    }
    const activeServerId = useActiveServerSnapshot(Boolean(source.serverId)).serverId;
    const selector = React.useMemo(() => {
        const address = normalizeSessionAddress(source.serverId, source.sessionId);
        let transcript: StorageState['sessionMessages'][string] | undefined;
        let structureVersion: number | undefined;
        let home: unknown;
        let sessionPresent = false;
        let latest: string | null = null;
        return (state: StorageState) => {
            const nextTranscript = state.sessionMessages[source.sessionId];
            const nextStructureVersion = nextTranscript?.transcriptStructureVersion ?? nextTranscript?.messagesVersion ?? 0;
            const nextHome = state.sessions[source.sessionId]?.serverId;
            const nextSessionPresent = state.sessions[source.sessionId] !== undefined;
            // Unrelated streaming and metadata writes do not rescan this transcript or rerender
            // historical cards. The retained row still has to prove its Home on every change.
            if (messageId === null) return false;
            if (structureVersion !== nextStructureVersion
                || transcript?.reducerState !== nextTranscript?.reducerState
                || transcript?.messageIdsOldestFirst !== nextTranscript?.messageIdsOldestFirst
                || transcript?.isLoaded !== nextTranscript?.isLoaded
                || home !== nextHome || sessionPresent !== nextSessionPresent) {
                transcript = nextTranscript;
                structureVersion = nextStructureVersion;
                home = nextHome;
                sessionPresent = nextSessionPresent;
                latest = latestWorkerUpdateMessageId(readStoredSessionMessagesForAddress(state, address, { activeServerId }), update);
            }
            return latest === messageId;
        };
    }, [source, activeServerId, update.workerId, update.workerKind, messageId]);
    const current = getStorage()(selector);
    return sameHome && !history.hasNewer && current;
}
