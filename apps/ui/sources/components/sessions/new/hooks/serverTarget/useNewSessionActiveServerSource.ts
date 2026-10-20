import * as React from 'react';

import { getServerProfilesGeneration, listServerProfiles, subscribeServerProfiles, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import {
    getActiveServerSnapshot,
    subscribeActiveServer,
} from '@/sync/domains/server/serverRuntime';

export type NewSessionActiveServerSource = Readonly<{
    activeServerId: string;
    serverProfiles: ReadonlyArray<ServerProfile>;
    serverProfilesSignature: string;
}>;

const emptyNewSessionActiveServerSource: NewSessionActiveServerSource = Object.freeze({
    activeServerId: '',
    serverProfiles: Object.freeze([]),
    serverProfilesSignature: '',
});

let lastNewSessionActiveServerSource: NewSessionActiveServerSource | null = null;
let lastNewSessionActiveServerSourceKey = '';

function subscribeNewSessionActiveServerSource(listener: () => void): () => void {
    const unsubscribeActiveServer = subscribeActiveServer(listener);
    const unsubscribeProfiles = subscribeServerProfiles(listener);
    return () => { unsubscribeActiveServer(); unsubscribeProfiles(); };
}

function getNewSessionActiveServerSourceSnapshot(): NewSessionActiveServerSource {
    let activeServerId = '';
    try {
        activeServerId = getActiveServerSnapshot().serverId;
    } catch {
        activeServerId = '';
    }

    // Consumers retain full profiles, including admitted connection descriptors.
    // Their canonical publication owns invalidation, not an id/name-only view.
    const serverProfilesSignature = String(getServerProfilesGeneration());
    const key = `${activeServerId}\u0002${serverProfilesSignature}`;
    if (lastNewSessionActiveServerSource && lastNewSessionActiveServerSourceKey === key) {
        return lastNewSessionActiveServerSource;
    }

    let serverProfiles: ReadonlyArray<ServerProfile> = [];
    try {
        serverProfiles = listServerProfiles().slice();
    } catch {
        serverProfiles = [];
    }

    if (!activeServerId && serverProfiles.length === 0) {
        lastNewSessionActiveServerSource = emptyNewSessionActiveServerSource;
        lastNewSessionActiveServerSourceKey = key;
        return emptyNewSessionActiveServerSource;
    }

    const source: NewSessionActiveServerSource = {
        activeServerId,
        serverProfiles,
        serverProfilesSignature,
    };
    lastNewSessionActiveServerSource = source;
    lastNewSessionActiveServerSourceKey = key;
    return source;
}

export function useNewSessionActiveServerSource(): NewSessionActiveServerSource {
    return React.useSyncExternalStore(
        subscribeNewSessionActiveServerSource,
        getNewSessionActiveServerSourceSnapshot,
        getNewSessionActiveServerSourceSnapshot,
    );
}
