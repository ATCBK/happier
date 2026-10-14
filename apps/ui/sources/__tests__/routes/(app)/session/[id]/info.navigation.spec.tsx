import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture, createPlainV2SessionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderRealAppRoute } from '@/dev/testkit/render/renderRealAppRoute';
import { initializeRootLayoutRuntimeForTests, installRootLayoutRouteCommonModuleMocks } from '../../rootLayoutRouteTestHelpers';

const boundary = vi.hoisted(() => ({
    history: false,
    serverId: '',
    back: vi.fn(),
    replace: vi.fn(),
    options: {} as Record<string, unknown>,
}));
installRootLayoutRouteCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: '/session/session-info/info',
        params: () => ({ id: 'session-info', serverId: boundary.serverId }),
        navigation: {
            canGoBack: () => boundary.history,
            goBack: boundary.back,
            setOptions: (options: Record<string, unknown>) => { Object.assign(boundary.options, options); },
        },
        router: { back: boundary.back, replace: boundary.replace, canGoBack: () => boundary.history },
    }).module,
});
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// The real route's bug-report/attachment imports reach the native filesystem SDK.
vi.mock('expo-file-system', async () => (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);

await initializeRootLayoutRuntimeForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/navigationTitleChrome');
const SessionInfo = (await import('@/app/(app)/session/[id]/info')).default;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
    boundary.back.mockClear();
    boundary.replace.mockClear();
    boundary.options = {};
});

describe('Session Info departure through its real route', () => {
    it.each([
        { presentation: 'wide retained page', phone: false, hosted: true, history: false },
        { presentation: 'phone retained page', phone: true, hosted: true, history: false },
        { presentation: 'native overlay with history', phone: true, hosted: false, history: true },
    ])('offers one accessible exit on $presentation', async ({ phone, hosted, history }) => {
        boundary.history = history;
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://session-info.example.test', serverIdentityId: 'srv_session_info_home',
            request: async input => {
                const pathname = new URL(String(input)).pathname;
                if (pathname === '/health' || pathname === '/v1/auth/ping') return Response.json({ ok: true });
                if (pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_session_info_home' } },
                }));
                if (pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'account-a' });
                if (pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (pathname === '/v2/sessions/session-info') return Response.json({ session: createPlainV2SessionRecordFixture({ id: 'session-info' }) });
                return new Response('{}', { status: 404 });
            },
        });
        boundary.serverId = connection.serverId;
        storage.getState().applySessions([createSessionFixture({ id: 'session-info', serverId: boundary.serverId })]);
        function Context({ children }: React.PropsWithChildren) {
            return hosted ? <DestinationInstanceHost tabId="session-info"
                ref={{ kind: 'session', params: { id: 'session-info', serverId: boundary.serverId } }}
                pathname="/session/session-info/info" focused visible phone={phone}
                navigation={{ push: () => {}, back: boundary.back, replace: boundary.replace, canGoBack: () => history }}>
                {children}
            </DestinationInstanceHost> : <NavigationTitleChromeProvider showsTitle>{children}</NavigationTitleChromeProvider>;
        }
        const screen = await renderRealAppRoute(SessionInfo, connection.credentials, { contextWrapper: Context });
        await flushHookEffects();
        expect(screen.findHostByTestId('session-info-header')).not.toBeNull();
        const nativeLeft = boundary.options.headerLeft;
        const nativeHeader = !hosted && typeof nativeLeft === 'function'
            ? await (await import('@/dev/testkit/render/renderScreen')).renderScreen(<>{nativeLeft()}</>)
            : null;
        const exitScreen = nativeHeader ?? screen;
        expect(exitScreen.findAllHostsByTestId('session-info-close')).toHaveLength(1);
        const close = exitScreen.findHostByTestId('session-info-close');
        expect(close).not.toBeNull();
        expect(close?.props.accessibilityRole).toBe('button');
        expect(close?.props.accessibilityLabel).toBe((await import('@/text')).t('common.close'));
        await exitScreen.pressByTestIdAsync('session-info-close');
        if (history) {
            expect(boundary.back).toHaveBeenCalledOnce();
            expect(boundary.replace).not.toHaveBeenCalled();
        } else {
            expect(boundary.replace).toHaveBeenCalledExactlyOnceWith('/');
            expect(boundary.back).not.toHaveBeenCalled();
        }
    });
});
