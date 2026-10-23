import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

import { useNewSessionPlacementSessions } from './useNewSessionPlacementSessions';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('useNewSessionPlacementSessions', () => {
    afterEach(() => {
        storage.setState({ sessions: {}, isDataReady: false });
    });

    it('does not render for Session publications and reads current placement history on demand', async () => {
        const first = createSessionFixture({ id: 's1', createdAt: 1, metadata: { path: '/w/app', host: 'mac', machineId: 'm1' } as never });
        storage.setState({ sessions: { s1: first }, isDataReady: true });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useNewSessionPlacementSessions();
        });
        const readSessions = () => {
            const current = hook.getCurrent();
            return typeof current === 'function' ? current() : current;
        };
        const initial = readSessions();
        expect(initial?.map((session) => session.id)).toEqual(['s1']);
        const rendersAfterMount = renders;

        // Session title/status publications have no visible placement consumer while closed.
        for (let index = 0; index < 5; index += 1) {
            await act(async () => {
                storage.setState({ sessions: { s1: { ...first, updatedAt: 99 + index, active: true, thinking: true,
                    metadata: { ...first.metadata!, summary: { text: `Title ${index}`, updatedAt: 99 + index } },
                } } });
            });
        }
        expect(readSessions()?.[0]?.updatedAt).toBe(103);
        expect(renders).toBe(rendersAfterMount);

        // A new session starts somewhere: placement history changed.
        const second = createSessionFixture({ id: 's2', createdAt: 2, metadata: { path: '/w/site', host: 'mac', machineId: 'm1' } as never });
        await act(async () => {
            storage.setState({ sessions: { s1: first, s2: second } });
        });
        expect(readSessions()?.map((session) => session.id)).toEqual(['s1', 's2']);
        expect(renders).toBe(rendersAfterMount);

        // Its folder changes.
        await act(async () => {
            storage.setState({ sessions: { s1: first, s2: { ...second, metadata: { path: '/w/other', host: 'mac', machineId: 'm1' } as never } } });
        });
        expect(readSessions()?.[1]?.metadata?.path).toBe('/w/other');
        expect(renders).toBe(rendersAfterMount);

        await hook.unmount();
    });

    it('publishes readiness for a missing default and keeps open history current', async () => {
        storage.setState({ sessions: {}, isDataReady: false });
        const hook = await renderHook(() => useNewSessionPlacementSessions(true));
        const readSessions = () => {
            const current = hook.getCurrent();
            return typeof current === 'function' ? current() : current;
        };
        expect(readSessions()).toBeNull();
        const first = createSessionFixture({ id: 's1', metadata: { path: '/arrived', host: 'mac', machineId: 'm1' } as never });
        await act(async () => storage.setState({ sessions: { s1: first }, isDataReady: true }));
        expect(readSessions()?.[0]?.metadata?.path).toBe('/arrived');
        const beforeMove = hook.getCurrent();
        await act(async () => storage.setState({ sessions: { s1: { ...first, metadata: { ...first.metadata!, path: '/moved' } } } }));
        expect(hook.getCurrent()).not.toBe(beforeMove);
        expect(readSessions()?.[0]?.metadata?.path).toBe('/moved');
        await hook.unmount();
    });
});
