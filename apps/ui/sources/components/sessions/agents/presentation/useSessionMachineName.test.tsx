import { afterEach, expect, it } from 'vitest';

import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';

import { useSessionMachineName } from './useSessionMachineName';

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); });

it('names the machine a Session ran on from the Session itself when its Machine record is not loaded, as the Session view and its Work rows do', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    storage.getState().activateProfileScope({ serverId, accountId: 'account-1' });
    storage.getState().applySessions([createSessionFixture({
        id: 'lead', metadata: { ...createSessionFixture().metadata!, host: 'ubuntu-02' },
    })]);
    const hook = await renderHook(() => useSessionMachineName('lead', serverId));
    expect(hook.getCurrent()).toBe('ubuntu-02');
});
