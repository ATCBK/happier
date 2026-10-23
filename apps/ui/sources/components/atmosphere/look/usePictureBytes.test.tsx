import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { pictureStore } from '../pictureStore.web';
import { useStoredPicture, useUserPictures } from './usePictureBytes';

// Exercise the real browser persistence adapter instead of Node's native platform default.
vi.mock('../pictureStore', () => import('../pictureStore.web'));

it('keeps user picture readers and the user library asleep during builtin thumbnail writes', async () => {
    const localId = 'picker-locality-user';
    await pictureStore.put({ localId, kind: 'user', data: new Blob(['user pixels']) });
    let current: { stored: ReturnType<typeof useStoredPicture>; users: ReturnType<typeof useUserPictures> } | undefined;
    function Probe() {
        current = { stored: useStoredPicture(localId), users: useUserPictures() };
        return null;
    }
    const screen = await renderScreen(<Probe />);
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    const cursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
    try {
        await vi.waitFor(() => expect(current?.stored.status).toBe('present'));
        await vi.waitFor(() => expect(current?.users.some(value => value.localId === localId)).toBe(true));
        get.mockClear(); cursor.mockClear();
        for (let index = 0; index < 19; index++) {
            await act(async () => { await pictureStore.put({ localId: `builtin-thumb:picker-locality-${index}`,
                kind: 'builtin', data: new Blob(['thumbnail']) }); });
        }
        expect(get.mock.calls.filter(([id]) => id === localId)).toHaveLength(0);
        expect(cursor).toHaveBeenCalledTimes(0);
        await act(async () => { await pictureStore.remove(localId); });
        await vi.waitFor(() => expect(current?.stored.status).toBe('missing'));
        await vi.waitFor(() => expect(current?.users.some(value => value.localId === localId)).toBe(false));
    } finally {
        get.mockRestore(); cursor.mockRestore();
        await screen.unmount();
        await pictureStore.remove(localId);
        for (let index = 0; index < 19; index++) await pictureStore.remove(`builtin-thumb:picker-locality-${index}`);
    }
});
