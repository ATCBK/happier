import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { useSessionAgentCatalogIdentity } from './useSessionAgentCatalogIdentity';

describe('useSessionAgentCatalogIdentity', () => {
    it.each([
        ['claude', 'claude'],
        ['unknown-agent', null],
    ] as const)('exposes the catalog mark for a %s Session', async (flavor, expectedMark) => {
        const session = createSessionFixture({ metadata: {
            path: '/repo', host: 'test', machineId: 'machine-a', flavor,
        } });
        const hook = await renderHook(() => useSessionAgentCatalogIdentity({
            agentId: readSessionPresentationAgentId(session) ?? '',
            machineId: session.metadata?.machineId ?? null,
            serverId: null,
        }));
        try {
            expect(hook.getCurrent().markAgentId).toBe(expectedMark);
        } finally {
            await hook.unmount();
        }
    });
});
