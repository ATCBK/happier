import * as React from 'react';

import { isSessionContentUnsettled as isSessionRowContentUnsettled } from '@/sync/domains/session/encryptedContentAvailability';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { retainVisibleSessionListSurfaces } from '@/sync/domains/session/sessionSurfaceVisibility';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * Whether a Session's content is still waiting for a decision: an encrypted row no decryption owner
 * has settled yet (neither readable nor blocked). A row this device has not listed is undecided too.
 */
function isSessionContentUnsettled(address: SessionAddress): boolean {
    const row = readSessionListRowForServerId(
        readRegisteredStorageState()?.sessionListRowsByServerId, address.serverId, address.sessionId,
    );
    return row === null || isSessionRowContentUnsettled(row);
}

/**
 * The one owner of "a surface that shows a Session demands its content". A Session shown anywhere
 * outside its own page names itself from encrypted content, and an encrypted row nobody has decided is
 * only unsettled, not locked: without this demand it reads as "Encrypted session" until some other
 * surface happens to hydrate it. Every such surface passes the Sessions it shows right now; this retains
 * them as visible, hydrates the ones that entered the demand, and releases them when the surface
 * hides, unmounts or its Home scope resets.
 *
 * - `viewport` hydrates every Session that enters (a scrolling list refreshes each row it reveals).
 * - `unsettled` hydrates only entered Sessions whose content is still undecided.
 */
export function useSessionContentDemand(
    addresses: readonly SessionAddress[],
    options: Readonly<{
        tag: string;
        hydrate: 'viewport' | 'unsettled';
        /** The surface is not showing its Sessions (inactive pane): nothing is demanded. */
        active?: boolean;
        /** A server-scope reset releases every retained row; re-entry then hydrates again. */
        resetVersion?: number;
    }>,
): void {
    const { tag, hydrate, active = true, resetVersion = 0 } = options;
    const previous = React.useRef<Readonly<{ keys: ReadonlySet<string>; resetVersion: number }>>({ keys: new Set(), resetVersion });
    // Callers rebuild their arrays freely; the demand follows the Sessions, not the array identity.
    const identity = addresses.map(sessionAddressKey).join('\u0000');
    React.useEffect(() => {
        const demanded = active ? addresses : [];
        const earlier = previous.current.resetVersion === resetVersion ? previous.current.keys : new Set<string>();
        previous.current = { keys: new Set(demanded.map(sessionAddressKey)), resetVersion };
        if (demanded.length === 0) return;
        const entered = demanded.filter(address => !earlier.has(sessionAddressKey(address)));
        const release = retainVisibleSessionListSurfaces(demanded);
        const toHydrate = hydrate === 'unsettled' ? entered.filter(isSessionContentUnsettled) : entered;
        if (toHydrate.length > 0) fireAndForget(sync.hydrateSessionListRows(toHydrate), { tag });
        return release;
        // The addresses are fully described by their identity key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [identity, active, resetVersion, hydrate, tag]);
}
