import * as React from 'react';
import { usePluginHostApi, useSurfaceContext } from '@happier-dev/plugin-ui';
import { resolveTriageSourceSessionRelationsV1, resolveTriageSourceDescriptorV1 } from '../../ui/detail/sourceSurface.js';

import { useTriageDurableAccount } from '../../ui/durable/accountDurableState.js';
import {
    createActionTriageUnlinkTransport,
    createDirectTriageUnlinkTransport,
    type TriageUnlinkLinkedEntryV1,
} from './unlinkLinkedEntry.js';

/** Both ends of a relationship use the same admitted removal and authoritative reread. */
export function useTriageUnlinkLinkedEntry(onRefresh: () => void | Promise<void>) {
    const host = usePluginHostApi();
    const durable = useTriageDurableAccount();
    const { targetedContributions } = useSurfaceContext();
    const transport = React.useMemo(
        () => durable.collections
            ? createDirectTriageUnlinkTransport(durable.collections, host,
                (entryRef) => resolveTriageSourceDescriptorV1(targetedContributions, entryRef.source) === null
                    ? undefined : resolveTriageSourceSessionRelationsV1(targetedContributions, entryRef.source, 'linkSession'))
            : createActionTriageUnlinkTransport(host),
        [durable.collections, host, targetedContributions],
    );
    const [phase, setPhase] = React.useState<'idle' | 'removing' | 'failed'>('idle');
    const unlink = React.useCallback(async (target: TriageUnlinkLinkedEntryV1) => {
        if (phase === 'removing') return;
        setPhase('removing');
        try {
            const result = await transport.unlink(target);
            if (result === null) {
                setPhase('idle');
                return;
            }
            if (result.status === 'failed') {
                setPhase('failed');
                return;
            }
            // A conflict also requires a reread; it never authorizes a forced delete.
            await onRefresh();
            setPhase('idle');
        } catch {
            setPhase('failed');
        }
    }, [onRefresh, phase, transport]);
    return { phase, unlink };
}
