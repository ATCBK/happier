import { useOpenDiscussion } from '@/components/discussions/useOpenDiscussion';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

/** People supplies a source link while the canonical Discussion owns its destination and lifetime. */
export function useOpenSessionDiscussion(input: Readonly<{
    address: SessionAddress;
    sourceSurface?: SessionMobileSurface;
}>) {
    return useOpenDiscussion({
        address: { serverId: input.address.serverId },
        anchor: { kind: 'session', sessionId: input.address.sessionId },
        sourceSurface: input.sourceSurface ?? 'collaboration',
    });
}
