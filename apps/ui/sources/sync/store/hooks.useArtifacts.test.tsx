import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { useArtifacts } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

describe('useArtifacts', () => {
    it('publishes available Artifact rows while unrelated initial Sync work is still pending', async () => {
        const previousState = storage.getState();
        const openNotice = createUsageNoticeArtifactFixture({ id: 'open-notice' });
        const draft = createUsageNoticeArtifactFixture({ id: 'draft-notice', draft: true });
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: false,
                artifactsLoaded: true,
                artifacts: {
                    [openNotice.id]: openNotice,
                    [draft.id]: draft,
                },
            }));

            const hook = await renderHook(() => useArtifacts());

            expect(hook.getCurrent()).toEqual([openNotice]);
            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });
});
