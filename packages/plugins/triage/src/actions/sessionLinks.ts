import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { createTriageSourceSessionRelations } from '../sessions/sourceSessionRelations.js';
import { isTriageAccountCaller } from './callerSource.js';
import type {
    TriageLinkEntryToSessionActionResultV1,
    TriageLinkEntryToSessionInputV1,
    TriageReadSourceSessionLinksInputV1,
    TriageReadSourceSessionLinksResultV1,
} from './sessionLinksProtocol.js';

/**
 * The registered source-neutral relationship transport.
 *
 * Source-declared roles own their relationships; `linkEntryToSession` owns external links'
 * derived address, its idempotency, the conditional tombstone rewrite, the
 * minted publication id and the conflict verdict; this module transports the
 * caller's intent to the selected owner and projects its answer back, discarding the storage
 * tag on the way out.
 */

export function createTriageLinkEntryToSessionActionHandler(): ActionHandler<
    TriageLinkEntryToSessionInputV1,
    TriageLinkEntryToSessionActionResultV1
> {
    return async (input, context: PluginInvocationContext) => {
        const collections = bindCorpusCollections(requireTriageAccountStorage(context));
        const result = await createTriageSourceSessionRelations(context, collections).write({ ...input, linked: true });
        return { v: 1, status: result.status === 'linked' ? 'linked' : 'failed' };
    };
}

export function createTriageReadSourceSessionLinksActionHandler(): ActionHandler<
    TriageReadSourceSessionLinksInputV1, TriageReadSourceSessionLinksResultV1
> {
    return async (input, context) => {
        if (!isTriageAccountCaller(context)) return { kind: 'failed', links: [] };
        try {
            const result = await createTriageSourceSessionRelations(context,
                bindCorpusCollections(requireTriageAccountStorage(context))).read(input);
            return { kind: result.kind, links: result.links, lanes: result.lanes };
        } catch { return { kind: 'failed', links: [] }; }
    };
}
