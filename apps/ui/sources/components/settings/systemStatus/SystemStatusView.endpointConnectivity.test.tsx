import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeGovernanceHarness, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import type { IrohHomeTransportDiagnosticsPublisher } from '@/sync/runtime/irohHomeTransportDiagnostics';

installDisconnectedServerSocketBoundary(socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});

const home = createHomeGovernanceHarness();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let diagnosticsPublisher: IrohHomeTransportDiagnosticsPublisher | null = null;
let activeHomeId: string | null = null;
let carrierTarget: ReturnType<typeof captureActiveServerRuntimeTarget> | null = null;

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
    standardCleanup();
    if (carrierTarget) releaseActiveServerRuntimeOrigin({ target: carrierTarget, leaseId: 'endpoint-test-carrier' });
    carrierTarget = null;
    if (activeHomeId) retireIrohHomeTransportDiagnostics(activeHomeId);
    diagnosticsPublisher = null;
    activeHomeId = null;
    await connection?.dispose();
    connection = null;
    await home.reset();
    storage.setState(beforeStorage, true);
});

vi.mock('react-native-mmkv', () => {
    class MMKV {
        #store = new Map<string, string>();

        public getString(key: string): string | undefined {
            return this.#store.get(key);
        }

        public set(key: string, value: string): void {
            this.#store.set(key, value);
        }

        public delete(key: string): void {
            this.#store.delete(key);
        }
    }

    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), setParams: vi.fn() } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Readonly<Record<string, unknown>>) => (
            key === 'connectionStatus.values.relayAutomatic'
                ? `${key} ${String(params?.relays ?? '')}`
                : key
        ),
        translateLoose: (key: string) => key,
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' }, deviceName: 'test-device' },
}));

vi.mock('expo-application', () => ({
    nativeApplicationVersion: '0.0.0-test', nativeBuildVersion: '1', applicationId: 'dev.happier.test',
}));

vi.mock('expo-updates', async () => (await import('@/dev/testkit/mocks/expoUpdates')).createExpoUpdatesMock());

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

// Load real screen owners after boundary setup, outside behavior deadlines.
const { adoptHomeProfile, getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
const { getActiveServerSnapshot, captureActiveServerRuntimeTarget, publishActiveServerRuntimeOrigin, releaseActiveServerRuntimeOrigin } = await import('@/sync/domains/server/serverRuntime');
const { createIrohHomeTransportDiagnosticsPublisher, retireIrohHomeTransportDiagnostics } = await import('@/sync/runtime/irohHomeTransportDiagnostics');
const { storage } = await import('@/sync/domains/state/storageStore');
const { SystemStatusView } = await import('./SystemStatusView');
const { useActiveHomeConnectionHealth } = await import('@/components/navigation/connectionStatus/useConnectionHealth');
const beforeStorage = storage.getState();

async function prepareHome(publicServerUrl?: string | null, serverUrl = 'https://legacy.example.test') {
    const serverIdentityId = `srv_${new URL(serverUrl).hostname}`;
    const homeId = await home.addHome({
        name: 'Personal Home', serverUrl, serverIdentityId,
        ...(publicServerUrl !== undefined ? { publicServerUrl } : {}),
        accountId: 'account-a',
    });
    if (typeof publicServerUrl === 'string') {
        await adoptHomeProfile({
            source: 'manual', descriptorAuthority: 'current_connection_observation',
            descriptor: {
                v: 1, homeServerIdentityId: serverIdentityId, canonicalServerUrl: serverUrl,
                revision: 1, endpoints: [{ kind: 'https', url: publicServerUrl }],
            },
        });
    }
    home.answer(homeId, '/v1/machines', { body: [] });
    connection = await restoreServerAccountForTest({ serverUrl, request: async (input, init) => {
        const response = await home.request(input, init);
        if (response.status !== 404) return response;
        const url = new URL(String(input));
        return createEmptyAccountBootstrapHttpResponse(`${url.pathname}${url.search}`, init) ?? response;
    } });
    activeHomeId = getActiveServerSnapshot().serverId;
    expect(getServerProfileById(activeHomeId)?.publicServerUrl)
        .toBe(publicServerUrl);
    const appliedServerId = activeHomeId;
    storage.setState(current => ({
        isDataReady: true,
        profileScope: { serverId: appliedServerId, accountId: 'account-a' },
        profile: { ...current.profile, id: 'account-a', username: 'u1', connectedServices: [] },
        machines: {},
        machineListByServerId: { [appliedServerId]: [] },
        machineListStatusByServerId: { [appliedServerId]: 'idle' },
    }));
}

describe('SystemStatusView (endpoint connectivity)', () => {
    it('subscribes to active Home diagnostics and separates effective carrier from last-known Iroh path', async () => {
        await prepareHome('https://legacy.example.test');
        if (!activeHomeId) throw new Error('Missing active Home');
        expect(getActiveServerSnapshot().carrier).toBe('https');
        diagnosticsPublisher = createIrohHomeTransportDiagnosticsPublisher({
            producerId: 'system-status-test', leaseId: 'endpoint-test-diagnostics', homeServerIdentityId: activeHomeId,
        });
        diagnosticsPublisher.publish({
            homeServerIdentityId: activeHomeId,
            state: 'reconnecting',
            lastKnown: { carrier: 'iroh', observedPath: 'relay' },
            effectiveConfiguration: {
                policy: 'automatic', relayUrls: ['https://relay.example.test'],
                relayUrlCount: 3, relayUrlsTruncated: true, directAddressCount: 0,
            },
        });
        const screen = await renderScreen(<SystemStatusView />);
        const health = await renderHook(() => useActiveHomeConnectionHealth());
        await waitForHomeGovernance(() => expect(health.getCurrent().kind).toBe('no_machine'));

        const joined = screen.getTextContent();
        expect(joined).toContain(activeHomeId);
        expect(joined).toContain('https://legacy.example.test');
        expect(joined).toContain('connectionStatus.labels.publicIngress https://legacy.example.test');
        expect(joined).toContain('connectionStatus.labels.effectiveCarrier');
        expect(joined).toContain('HTTPS');
        expect(joined).toContain('Iroh');
        expect(joined).toContain('systemStatus.transport.irohHistory');
        expect(joined).not.toContain('systemStatus.transport.irohCurrent');
        expect(joined).toContain('systemStatus.server.activeHomeHealth');
        // The active Home's health is connected even though Iroh history can say reconnecting.
        expect(screen.findAll((node) => node.props?.title === 'systemStatus.server.activeHomeHealth'
            && node.props?.detail === 'connectionStatus.summary.connected').length).toBeGreaterThan(0);
        expect(joined).toContain('connectionStatus.labels.lastKnownPath');
        expect(joined).toContain('connectionStatus.values.pathRelay');
        expect(joined).toContain('connectionStatus.labels.relayConfiguration');
        expect(joined).toContain('1/3');
        expect(joined).not.toContain('connectionStatus.labels.currentPath');

        carrierTarget = captureActiveServerRuntimeTarget();
        await act(async () => {
            diagnosticsPublisher!.publish({
                homeServerIdentityId: activeHomeId!, state: 'connected',
                current: { carrier: 'iroh', observedPath: 'direct' },
                lastKnown: { carrier: 'iroh', observedPath: 'direct' },
            });
        });

        const updated = screen.getTextContent();
        expect(updated).toContain('systemStatus.transport.irohHistory');
        expect(updated).not.toContain('systemStatus.transport.irohCurrent');
        expect(updated).toContain('connectionStatus.labels.lastKnownPath');
        expect(updated).not.toContain('connectionStatus.labels.currentPath');
        expect(updated).toContain('connectionStatus.values.pathDirect');

        await act(async () => {
            expect(publishActiveServerRuntimeOrigin({
                target: carrierTarget!, leaseId: 'endpoint-test-carrier',
                runtimeOrigin: 'http://127.0.0.1:43123', carrier: 'iroh',
            })).toBe(true);
        });
        expect(getActiveServerSnapshot().carrier).toBe('iroh');

        const liveIroh = screen.getTextContent();
        expect(liveIroh).toContain('systemStatus.transport.irohCurrent');
        expect(liveIroh).toContain('connectionStatus.labels.currentPath');
        expect(liveIroh).not.toContain('connectionStatus.labels.lastKnownPath');
    });

    it('keeps unknown public ingress distinct from a Home known to have no public ingress', async () => {
        await prepareHome(undefined, 'https://unknown.example.test');
        const screen = await renderScreen(<SystemStatusView />);

        const joined = screen.getTextContent();
        expect(joined).toContain('connectionStatus.labels.publicIngress');
        expect(joined).toContain('connectionStatus.labels.publicIngress —');
        expect(joined).not.toContain('connectionStatus.values.publicIngressAbsent');
    });

    it('shows a Home known to have no public ingress distinctly from an unknown endpoint', async () => {
        await prepareHome(null, 'https://absent.example.test');
        const screen = await renderScreen(<SystemStatusView />);

        expect(screen.getTextContent()).toContain('connectionStatus.values.publicIngressAbsent');
        expect(screen.getTextContent()).not.toContain('connectionStatus.labels.publicIngress —');
    });
});
