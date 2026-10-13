import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { useRetireProviderStateOnAccountChange } = await import('./accountLifetimeRetirement');
afterEach(async () => { standardCleanup(); await account.reset(); });

describe('Provider draft retirement through the real Account lifetime', () => {
    it('retains the mounted draft, clears it once on Account replacement and detaches an unmounted consumer', async () => {
        await account.restore({ accountId: 'author-a', machines: [] });
        const mounted = await renderHook(() => {
            const [state, setState] = React.useState<{ draft: string | null; retirements: number }>({ draft: 'Unsent Provider edit', retirements: 0 });
            const retire = React.useCallback(() => setState(current => ({ draft: null, retirements: current.retirements + 1 })), []);
            useRetireProviderStateOnAccountChange(retire);
            return state;
        });
        let detachedDraft: string | null = 'Detached edit';
        const detached = await renderHook(() => useRetireProviderStateOnAccountChange(() => { detachedDraft = null; }));
        await detached.unmount();
        await mounted.rerender();
        expect(mounted.getCurrent()).toEqual({ draft: 'Unsent Provider edit', retirements: 0 });
        await act(async () => { await account.restore({ accountId: 'author-b', machines: [] }); });
        expect(mounted.getCurrent()).toEqual({ draft: null, retirements: 1 });
        expect(detachedDraft).toBe('Detached edit');
        await mounted.rerender();
        expect(mounted.getCurrent()).toEqual({ draft: null, retirements: 1 });
    });
});
