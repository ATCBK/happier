import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { useOpenSessionDiscussion } from '@/components/sessions/conversations/useOpenSessionDiscussion';
import { useOpenDiscussion } from './useOpenDiscussion';

const route = vi.hoisted(() => ({ push: vi.fn(), pathname: '/discussions', params: {} as Record<string, string | string[]> }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: route.push }, pathname: () => route.pathname, params: () => route.params }).module;
});

describe('open Discussion', () => {
    beforeEach(() => {
        route.push.mockClear();
        route.pathname = '/discussions';
        route.params = { serverId: 'home-b' };
    });
    afterEach(standardCleanup);

    it('opens the canonical resource without a parent Session and retains the captured Home', async () => {
        const hook = await renderHook(({ serverId }: { serverId: string }) => useOpenDiscussion({ address: { serverId } }), {
            initialProps: { serverId: 'home-b' },
        });
        const capturedOpen = hook.getCurrent().openDiscussion;
        await hook.rerender({ serverId: 'home-c' });
        await act(async () => capturedOpen('same-id'));
        expect(route.push).toHaveBeenLastCalledWith('/discussions/same-id?serverId=home-b');
        await act(async () => hook.getCurrent().openDiscussion('same-id'));
        expect(route.push).toHaveBeenLastCalledWith('/discussions/same-id?serverId=home-c');
        await act(async () => hook.getCurrent().openNewDiscussion());
        expect(route.push).toHaveBeenLastCalledWith('/discussions/new?serverId=home-c');
    });

    it('derives selection from the canonical route and exact Home', async () => {
        route.pathname = '/discussions/same-id';
        route.params = { serverId: 'home-b', discussionId: 'same-id' };
        const hook = await renderHook(() => useOpenDiscussion({ address: { serverId: 'home-b' } }));
        expect(hook.getCurrent().activeDiscussionKey).toBe('same-id');
        route.params = { serverId: 'home-c', discussionId: 'same-id' };
        await hook.rerender();
        expect(hook.getCurrent().activeDiscussionKey).toBeNull();
        route.params = { serverId: 'home-b' };
        route.pathname = '/discussions/new';
        await hook.rerender();
        expect(hook.getCurrent().activeDiscussionKey).toBe('new');
    });

    it('makes People an anchor adapter to the same canonical destination', async () => {
        const hook = await renderHook(() => useOpenSessionDiscussion({ address: { serverId: 'home-b', sessionId: 'source-a' } }));
        await act(async () => hook.getCurrent().openDiscussion('same-id'));
        expect(route.push).toHaveBeenLastCalledWith('/discussions/same-id?serverId=home-b&sourceSurface=collaboration');
        await act(async () => hook.getCurrent().openNewDiscussion());
        expect(route.push).toHaveBeenLastCalledWith('/discussions/new?serverId=home-b&sourceSurface=collaboration&anchorSessionId=source-a');
    });
});
