import { getStorage, selectSessionDisplayNameSource, useSessionDisplayNameProjections, type SessionDisplayNameSource } from '@/sync/domains/state/storage';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';

import { getSessionName, resolveLockedSessionTitle } from './sessionUtils';

/**
 * A session's name as every surface shows it (a tab, a drag preview, a chooser): the session title
 * owner's, locked titles included. One derivation, so a workspace tab and a drag preview
 * cannot name the same session differently.
 */
export function sessionDisplayTitle(source: SessionDisplayNameSource): string;
export function sessionDisplayTitle(source: SessionDisplayNameSource | null): string | null;
export function sessionDisplayTitle(source: SessionDisplayNameSource | null): string | null {
    if (!source) return null;
    const title = getSessionName(source, source.serverId);
    return isSessionContentReadable(readSessionContentAvailability(source)) ? title : resolveLockedSessionTitle(title);
}

/** A source byline may use a cached title only while its content is readable on this device. */
export function readableSessionDisplayTitle(source: SessionDisplayNameSource | null): string | null {
    return source && isSessionContentReadable(readSessionContentAvailability(source)) ? sessionDisplayTitle(source) : null;
}

/** A Home-qualified session's name, read once without subscribing (words of a drag verdict). */
export function readSessionDisplayTitle(address: Readonly<{ sessionId: string; serverId?: string | null }>): string | null {
    return sessionDisplayTitle(selectSessionDisplayNameSource(getStorage().getState(), address.sessionId, address.serverId ?? null));
}

/** Live names of Home-qualified sessions, in input order, through one store subscription. */
export function useSessionDisplayTitles(addresses: ReadonlyArray<Readonly<{ sessionId: string; serverId?: string | null }>>): readonly (string | null)[] {
    return useSessionDisplayNameProjections(addresses, sessionDisplayTitle);
}
