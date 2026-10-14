import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const routeState = vi.hoisted(() => ({ params: {} as Record<string, string | string[] | undefined> }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => routeState.params, pathname: '/settings/mcp-server' }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

const { default: LegacyMcpServerRoute } = await import('./mcp-server');
const { Redirect } = await import('expo-router');

afterEach(() => { routeState.params = {}; });

describe('the 0.2 MCP editor link', () => {
    it.each([
        [{ serverId: [' server/one ', 'ignored'], addMode: 'import-json' }, '/settings/mcp/server%2Fone'],
        [{ addMode: 'import-json' }, '/settings/mcp?add=paste'],
        [{ addMode: 'quick-install' }, '/settings/mcp?add=catalog'],
        [{ serverId: ' ', addMode: 'unknown' }, '/settings/mcp/new'],
    ] satisfies Array<[Record<string, string | string[] | undefined>, string]>)('opens the matching collection destination for %j', async (params, href) => {
        routeState.params = params;
        const screen = await renderScreen(<LegacyMcpServerRoute />);
        try {
            // The OS router is the boundary; both route entry and destination adapter stay real.
            const redirect = screen.tree.findByType(Redirect);
            expect(redirect.props.href).toBe(href);
        } finally {
            await screen.unmount();
        }
    });
});
