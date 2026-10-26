import { getStorage, selectSessionDisplayNameSource, useSessionDisplayNameProjections, type SessionDisplayNameSource } from '@/sync/domains/state/storage';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

import { getSessionName, resolveLockedSessionTitle } from './sessionUtils';

function isSessionTitleReadable(source: SessionDisplayNameSource): boolean {
    // Layout-1 owner identity is opened with Account material, independently of
    // the Session DEK. An empty admitted view proves an untitled owner Session;
    // ownership or key presence alone does not prove a readable title.
    return isSessionContentReadable(readSessionContentAvailability(source))
        || (source.metadataLayoutVersion === 1
            && isSessionAccessOwner(source.access, source.accessLevel)
            && readSessionOwnerMetadataView(source) !== null);
}

/**
 * A session's name as every surface shows it (a tab, a drag preview, a chooser): the session title
 * owner's, locked titles included. One derivation, so a workspace tab and a drag preview
 * cannot name the same session differently.
 */
export function sessionDisplayTitle(source: SessionDisplayNameSource, serverId?: string | null): string;
export function sessionDisplayTitle(source: SessionDisplayNameSource | null, serverId?: string | null): string | null;
export function sessionDisplayTitle(source: SessionDisplayNameSource | null, serverId?: string | null): string | null {
    if (!source) return null;
    const title = getSessionName(source, serverId ?? source.serverId);
    return isSessionTitleReadable(source) ? title : resolveLockedSessionTitle(title);
}

/** A source byline may use a title only while its shared or Account-owned title view is readable. */
export function readableSessionDisplayTitle(source: SessionDisplayNameSource | null): string | null {
    return source && isSessionTitleReadable(source) ? sessionDisplayTitle(source) : null;
}

/** A Home-qualified session's name, read once without subscribing (words of a drag verdict). */
export function readSessionDisplayTitle(address: Readonly<{ sessionId: string; serverId?: string | null }>): string | null {
    return sessionDisplayTitle(selectSessionDisplayNameSource(getStorage().getState(), address.sessionId, address.serverId ?? null));
}

/** Live names of Home-qualified sessions, in input order, through one store subscription. */
export function useSessionDisplayTitles(addresses: ReadonlyArray<Readonly<{ sessionId: string; serverId?: string | null }>>): readonly (string | null)[] {
    return useSessionDisplayNameProjections(addresses, sessionDisplayTitle);
}
