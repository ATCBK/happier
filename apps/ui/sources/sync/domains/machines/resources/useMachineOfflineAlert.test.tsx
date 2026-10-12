import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { useMachineOfflineAlert } from './useMachineOfflineAlert';

const before = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(before); });
it('reads only the opened current Account consent, independently of machine online state, and withdraws it on scope change', async () => {
    storage.setState({ settingsScope: { serverId: 'home-a', accountId: 'owner' }, profileScope: { serverId: 'home-a', accountId: 'owner' },
        settings: settingsParse({ machineOfflineAlertsV1: { machineIds: ['machine'] } }), machines: {}, machineListByServerId: {} });
    const hook = await renderHook(() => useMachineOfflineAlert({ serverId: 'home-a', machineId: 'machine' }));
    expect(hook.getCurrent()).toMatchObject({ status: 'ready', enabled: true });
    await act(async () => { storage.setState({ settings: settingsParse({ machineOfflineAlertsV1: { machineIds: [] } }) }); });
    expect(hook.getCurrent()).toMatchObject({ status: 'ready', enabled: false });
    await act(async () => { storage.setState({ profileScope: { serverId: 'home-b', accountId: 'owner' } }); });
    expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', enabled: null });
    expect(await hook.getCurrent().set(true)).toMatchObject({ saved: false, enabled: null });
    await hook.unmount();
});
