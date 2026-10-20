import { afterEach, expect, it } from 'vitest';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { useCollectionRailWidth } from './useCollectionRailWidth';

const previous = getStorage().getState();
afterEach(() => {
    standardCleanup();
    getStorage().setState(previous, true);
});

it('restores a keyed preference, preserves neighbouring commits and does not render for another rail', async () => {
    getStorage().getState().applyLocalSettings({ collectionRailWidthsV1: { machines: 350, teams: 290 } });
    const beforeMount = getStorage().getState();
    let renders = 0;
    const machines = await renderHook(() => {
        renders += 1;
        return useCollectionRailWidth('machines');
    });
    const teams = await renderHook(() => useCollectionRailWidth('teams'));
    expect(machines.getCurrent().widthPx).toBe(350);
    expect(getStorage().getState()).toBe(beforeMount);
    const beforeNeighbourChange = renders;
    await act(async () => teams.getCurrent().commit(310));
    expect(renders).toBe(beforeNeighbourChange);
    await act(async () => {
        machines.getCurrent().commit(375);
        teams.getCurrent().commit(325);
    });
    expect(loadLocalSettings().collectionRailWidthsV1).toEqual({ machines: 375, teams: 325 });
    await machines.unmount();
    const restored = await renderHook(() => useCollectionRailWidth('machines'));
    expect(restored.getCurrent().widthPx).toBe(375);
    await act(async () => restored.getCurrent().reset());
    expect(restored.getCurrent().widthPx).toBeUndefined();
    expect(loadLocalSettings().collectionRailWidthsV1).toEqual({ teams: 325 });
});
