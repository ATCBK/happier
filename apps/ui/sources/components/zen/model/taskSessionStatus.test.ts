import { describe, expect, it, vi } from 'vitest';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { resolveTaskSessionStatus } from './taskSessionStatus';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const now = 1_000_000;

describe('linked Zen task session status', () => {
    it.each([
        [{ latestTurnStatus: 'in_progress', thinking: true, thinkingAt: now }, 'working', 'working'],
        [{ hasPendingPermissionRequests: true, pendingRequestObservedAt: now }, 'needs_you', 'needs_you'],
        [{ latestTurnStatus: 'completed' }, 'ready_for_review', 'finished'],
        // A failed turn is an idle, danger-toned Session in the canonical awareness presentation.
        [{ latestTurnStatus: 'failed' }, 'failed', 'idle'],
        [{ latestTurnStatus: 'cancelled' }, 'stopped', 'idle'],
    ] as const)('projects canonical session facts %j without deciding Done', (overrides, state, bucket) => {
        const session = createSessionListRenderableSessionFixture({ active: true, activeAt: now, ...overrides });
        const facts = readSessionWorkStatusFacts(session, now);
        expect(resolveTaskSessionStatus({ session, facts })).toMatchObject({ state, presentation: { bucket } });
    });

    it('does not turn an absent, offline or quiet Session into completed work', () => {
        expect(resolveTaskSessionStatus(null)).toBeNull();
        for (const overrides of [{}, { active: false, activeAt: 1, presence: 1, latestTurnStatus: 'completed' as const }]) {
            const session = createSessionListRenderableSessionFixture({ active: true, activeAt: now, ...overrides });
            const status = resolveTaskSessionStatus({ session, facts: readSessionWorkStatusFacts(session, now) });
            expect(status?.state).not.toBe('ready_for_review');
        }
    });
});
