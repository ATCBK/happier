import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';
import { useAccountSessionFollowEditorHost } from './useAccountSessionFollowEditorHost';
import { openFollowNotificationSettings } from './openFollowNotificationSettings';

const platformState = vi.hoisted(() => ({ width: 390, height: 844 }));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));

// Device geometry and router are platform boundaries; feature decisions and host logic remain real.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        useWindowDimensions: () => platformState,
    });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: navigation.push } }).module;
});

const initialState = getStorage().getState();

beforeEach(() => {
    resetServerFeaturesClientForTests();
    getStorage().setState(initialState, true);
    navigation.push.mockReset();
    platformState.width = 390;
    platformState.height = 844;
});
afterEach(() => vi.unstubAllGlobals());

async function prepareHomes(following: unknown) {
    const active = await upsertServerProfile({ serverUrl: 'https://active-follow.example', name: 'Active', source: 'manual' });
    const target = await upsertServerProfile({ serverUrl: 'https://target-follow.example', name: 'Target', source: 'manual' });
    await setActiveServerId(active.id, { scope: 'device' });
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const response = buildServerFeaturesResponse();
        return new Response(JSON.stringify({
                ...response,
                features: {
                    ...response.features,
                    sessions: {
                        ...response.features.sessions,
                        enabled: true,
                        following: String(url).includes('target-follow.example') ? following : { enabled: true },
                    },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await getServerFeaturesSnapshot({ serverId: target.id, force: true });
    return { active, target };
}

describe('shared Account Session Follow editor host', () => {
    it('opens notification settings for an established exact Home and never falls back from a missing profile', async () => {
        const { active } = await prepareHomes({ enabled: true });
        const opened: string[] = [];
        await openFollowNotificationSettings({ serverId: active.id, navigate: () => opened.push(active.id) });
        await openFollowNotificationSettings({ serverId: 'missing-home', navigate: () => opened.push('missing-home') });
        expect(opened).toEqual([active.id]);
    });
    it('opens a full-height detail destination for the selected Home without changing it to the active Home', async () => {
        const { active, target } = await prepareHomes({ enabled: true });
        const hook = await renderHook(() => useAccountSessionFollowEditorHost({ serverId: target.id, sessionId: 'same-id' }));
        expect(hook.getCurrent().enabled).toBe(true);
        await act(async () => hook.getCurrent().openEditor({ address: { serverId: active.id, sessionId: 'same-id' } }));
        expect(navigation.push).not.toHaveBeenCalled();
        await act(async () => hook.getCurrent().openEditor({ address: { serverId: target.id, sessionId: 'same-id' }, archived: true }));
        const href = new URL(String(navigation.push.mock.calls[0]?.[0]), 'https://client.example');
        expect(href.pathname).toBe('/session/same-id/follow');
        expect(href.searchParams.get('serverId')).toBe(target.id);
        expect(href.searchParams.get('archived')).toBe('1');
        await hook.unmount();
    });

    it.each([undefined, { enabled: 'true' }, { enabled: false }])('hides Follow when the target Home feature is missing, malformed, or disabled', async (following) => {
        const { target } = await prepareHomes(following);
        const hook = await renderHook(() => useAccountSessionFollowEditorHost({ serverId: target.id, sessionId: 'same-id' }));
        expect(hook.getCurrent().enabled).toBe(false);
        await act(async () => hook.getCurrent().openEditor({ address: { serverId: target.id, sessionId: 'same-id' } }));
        expect(navigation.push).not.toHaveBeenCalled();
        expect(hook.getCurrent().editor).toBeNull();
        await hook.unmount();
    });

    it('keeps wide-screen editing anchored and delegates keyboard focus return to the canonical popover', async () => {
        platformState.width = 1280;
        const { target } = await prepareHomes({ enabled: true });
        const hook = await renderHook(() => useAccountSessionFollowEditorHost({ serverId: target.id, sessionId: 'same-id' }));
        await act(async () => hook.getCurrent().openEditor({ address: { serverId: target.id, sessionId: 'same-id' } }));
        expect(navigation.push).not.toHaveBeenCalled();
        const editor = hook.getCurrent().editor;
        expect(React.isValidElement(editor)).toBe(true);
        // The control places its parts in the one Follow panel, anchored to the trigger it returns focus to.
        const panel = editor?.props.frame({ title: 'Follow it', subtitle: 'How much', mark: null, body: null, footer: null });
        expect(panel?.props).toMatchObject({
            anchorRef: hook.getCurrent().anchorRef,
            focusReturnRef: hook.getCurrent().triggerRef,
            title: 'Follow it',
        });
        await act(async () => panel?.props.onRequestClose());
        expect(hook.getCurrent().editor).toBeNull();
        await hook.unmount();
    });
});
