import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    createMachineFixture,
    createRootLayoutFeaturesResponse,
    flushHookEffects,
    renderHook,
    standardCleanup,
    waitForTestEvent,
} from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

const isRecognitionAvailableMock = vi.hoisted(() => vi.fn(() => true));
const requestSpeechPermissionsMock = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: (options: Record<string, unknown>) =>
                options.ios ?? options.native ?? options.default ?? options.web ?? options.android,
        },
    });
});

vi.mock('expo-speech-recognition', () => ({
    ExpoSpeechRecognitionModule: {
        isRecognitionAvailable: isRecognitionAvailableMock,
        requestPermissionsAsync: requestSpeechPermissionsMock,
    },
}));

const account = createProviderSettingsAccountHarness();
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { notifyAuthCredentialsInvalidated } = await import('@/sync/runtime/orchestration/authCredentialsInvalidation');
const { useVoiceProviderLocalAvailability } = await import('./voiceProviderLocalAvailability');

type AvailabilityHookInput = Parameters<typeof useVoiceProviderLocalAvailability>[0];

function createReadyFeatures() {
    const base = createRootLayoutFeaturesResponse();
    return createRootLayoutFeaturesResponse({
        features: {
            voice: {
                enabled: true,
                happierVoice: { enabled: false },
            },
            machines: {
                enabled: true,
                rpc: {
                    enabled: true,
                    directPeer: { enabled: true },
                },
                liveStream: {
                    enabled: true,
                    directPeer: { enabled: false },
                    serverRouted: { enabled: true },
                },
            },
        },
        capabilities: {
            machines: {
                ...base.capabilities.machines,
                liveStream: {
                    serverRouted: {
                        caps: {
                            maxBitrateBps: 96_000,
                            maxFramesPerSecond: 50,
                            maxFrameBytes: 16_384,
                            maxDurationMs: 60_000,
                            maxTotalBytes: 4_000_000,
                            maxConcurrentStreamsPerAccount: 2,
                            maxConcurrentStreamsPerSocket: 1,
                            maxConcurrentStreamsPerMachine: 1,
                        },
                        disabledReason: null,
                    },
                },
            },
        },
    });
}

function createRelayDisabledFeatures(
    base: ReturnType<typeof createRootLayoutFeaturesResponse>,
) {
    return createRootLayoutFeaturesResponse({
        ...base,
        features: {
            ...base.features,
            machines: {
                ...base.features.machines,
                liveStream: {
                    ...base.features.machines.liveStream,
                    serverRouted: { enabled: false },
                },
            },
        },
        capabilities: {
            ...base.capabilities,
            machines: {
                ...base.capabilities.machines,
                liveStream: {
                    serverRouted: {
                        caps: null,
                        disabledReason: 'server_routed_live_stream_disabled',
                    },
                },
            },
        },
    });
}

function createDirectMachine() {
    return createMachineFixture({
        id: 'machine-1',
        daemonState: MachinePublishedDaemonStateV1Schema.parse({
            status: 'running',
            peerMediation: {
                loopback: {
                    endpoint: {
                        v: 1,
                        routeKind: 'loopback_direct',
                        url: 'http://127.0.0.1:39001',
                        endpointFingerprint: 'fingerprint-1',
                        expiresAt: Date.now() + 60_000,
                    },
                },
            },
        }),
    });
}

describe('useVoiceProviderLocalAvailability', () => {
    let readyFeatures: ReturnType<typeof createRootLayoutFeaturesResponse>;

    beforeEach(async () => {
        readyFeatures = createReadyFeatures();
        await account.restore({ features: readyFeatures, settings: {
            experiments: true, featureToggles: { 'voice.agent': true, 'execution.runs': true, 'voice.daemonInference': true },
        } });
        isRecognitionAvailableMock.mockReset().mockReturnValue(true);
        requestSpeechPermissionsMock.mockClear();
    });

    afterEach(async () => {
        standardCleanup();
        await account.reset();
        resetServerFeaturesClientForTests();
    });

    async function renderAvailabilityHook(input: AvailabilityHookInput = {}, onRender?: () => void) {
        const Wrapper = ({ children }: React.PropsWithChildren) => (
            <AuthProvider initialCredentials={{ token: account.home.findByServerUrl('https://provider-settings-account.test')!.token! }}>
                {children}
            </AuthProvider>
        );
        return await renderHook(
            () => {
                onRender?.();
                return useVoiceProviderLocalAvailability(input);
            },
            { wrapper: Wrapper },
        );
    }

    async function installMachine(machine: ReturnType<typeof createMachineFixture>) {
        await account.publishMachines(account.serverId, [machine]);
    }

    it('loads native recognition support passively without requesting microphone permission', async () => {
        isRecognitionAvailableMock.mockReturnValueOnce(false);
        const hook = await renderAvailabilityHook();

        expect(hook.getCurrent().nativeDevice).toEqual({
            requested: true,
            speechRecognition: 'unavailable',
        });
        expect(isRecognitionAvailableMock).toHaveBeenCalledTimes(1);
        expect(requestSpeechPermissionsMock).not.toHaveBeenCalled();
    });

    it('passes native daemon PCM capture availability into the provider resolver', async () => {
        const hook = await renderAvailabilityHook({
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
        });

        const localAvailability = hook.getCurrent();

        expect(localAvailability.daemon).toMatchObject({
            route: 'relay',
            modelState: 'ready',
            runtimeState: 'available',
            pcmCapture: 'available',
        });
    });

    it('keeps endpoint-only readiness quiet for unrelated Machine publications while observing endpoint expiry', async () => {
        primeServerFeaturesSnapshot({
            serverId: account.serverId,
            snapshot: { status: 'ready', features: createRelayDisabledFeatures(readyFeatures) },
        });
        const machine = createDirectMachine();
        let other = createMachineFixture({ id: 'other-machine', activeAt: Date.now() });
        await account.publishMachines(account.serverId, [machine, other]);
        let renders = 0;
        const hook = await renderAvailabilityHook({
            daemonMachineId: machine.id, daemonModelState: 'ready', daemonRuntimeState: 'available',
        }, () => { renders += 1; });
        expect(hook.getCurrent().daemon?.route).toBe('direct');
        const held = hook.getCurrent();
        const settledRenders = renders;
        let latest = machine;
        for (let tick = 1; tick <= 3; tick += 1) {
            latest = createMachineFixture({
                ...latest, seq: latest.seq + 1, daemonStateVersion: latest.daemonStateVersion + 1,
                metadataVersion: latest.metadataVersion + 1,
                metadata: { ...latest.metadata!, displayName: `Published name ${tick}` },
                daemonState: MachinePublishedDaemonStateV1Schema.parse({
                    ...structuredClone(machine.daemonState),
                    resources: { v: 1, vitals: { state: 'unavailable', reason: 'reader_failed', since: tick },
                        attention: { level: 'calm', reasons: [] } },
                }),
            });
            await act(async () => { await account.publishMachines(account.serverId, [latest, other]); });
            expect(hook.getCurrent()).toBe(held);
            expect(renders).toBe(settledRenders);
            other = createMachineFixture({ ...other, metadataVersion: other.metadataVersion + 1,
                metadata: { ...other.metadata!, displayName: `Other machine ${tick}` } });
            await act(async () => { await account.publishMachines(account.serverId, [latest, other]); });
            expect(renders).toBe(settledRenders);
        }

        const endpoint = machine.daemonState?.peerMediation?.loopback?.endpoint;
        if (!endpoint) throw new Error('Expected canonical direct endpoint fixture');
        const clock = vi.spyOn(Date, 'now').mockReturnValue(endpoint.expiresAt + 1);
        try {
            // Existing preflight observes expiry on a subsequent source publication;
            // unrelated content must not suppress that consumed currentness fact.
            await act(async () => {
                await account.publishMachines(account.serverId, [latest,
                    createMachineFixture({ ...other, metadataVersion: other.metadataVersion + 1 })]);
            });
            expect(hook.getCurrent().daemon?.route).toBe('relay_disabled');
            expect(renders).toBe(settledRenders + 1);
        } finally { clock.mockRestore(); }
    });

    it('recomputes the passive direct route when same-machine endpoint and server policy facts are lost and restored', async () => {
        const relayDisabledFeatures = createRelayDisabledFeatures(readyFeatures);
        primeServerFeaturesSnapshot({
            serverId: account.serverId,
            snapshot: { status: 'ready', features: relayDisabledFeatures },
        });
        const machine = createDirectMachine();
        await installMachine(machine);
        const hook = await renderAvailabilityHook({
            daemonMachineId: machine.id,
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
        });

        expect(hook.getCurrent().daemon?.route).toBe('direct');

        await act(async () => {
            await installMachine(createMachineFixture({
                ...machine,
                daemonState: MachinePublishedDaemonStateV1Schema.parse({ status: 'running', peerMediation: { loopback: {} } }),
            }));
        });
        expect(hook.getCurrent().daemon?.route).toBe('relay_disabled');

        await act(async () => {
            await installMachine(machine);
        });
        expect(hook.getCurrent().daemon?.route).toBe('direct');

        const rpcDisabled = createRootLayoutFeaturesResponse({
            ...relayDisabledFeatures,
            features: {
                ...relayDisabledFeatures.features,
                machines: {
                    ...relayDisabledFeatures.features.machines,
                    rpc: {
                        enabled: true,
                        directPeer: { enabled: false },
                    },
                },
            },
        });
        await act(async () => {
            primeServerFeaturesSnapshot({
                serverId: account.serverId,
                snapshot: { status: 'ready', features: rpcDisabled },
            });
        });
        expect(hook.getCurrent().daemon?.route).toBe('relay_disabled');

        await act(async () => {
            primeServerFeaturesSnapshot({
                serverId: account.serverId,
                snapshot: { status: 'ready', features: relayDisabledFeatures },
            });
        });
        expect(hook.getCurrent().daemon?.route).toBe('direct');
    });

    it('recomputes passive direct readiness when mounted AuthContext credentials are lost and restored', async () => {
        const relayDisabledFeatures = createRelayDisabledFeatures(readyFeatures);
        primeServerFeaturesSnapshot({
            serverId: account.serverId,
            snapshot: { status: 'ready', features: relayDisabledFeatures },
        });
        const machine = createDirectMachine();
        await installMachine(machine);
        const hook = await renderAvailabilityHook({
            daemonMachineId: machine.id,
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
        });
        expect(hook.getCurrent().daemon?.route).toBe('direct');

        const serverUrl = 'https://provider-settings-account.test';
        const target = { serverId: account.serverId };
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, target);
        if (!credentials) throw new Error('Expected restored Home credentials');
        await act(async () => {
            // Auth invalidation reloads device credential storage, not the HTTP Home record.
            expect(await TokenStorage.removeCredentialsForServerUrl(serverUrl, target)).toBe(true);
            notifyAuthCredentialsInvalidated({
                kind: 'credentials_removed',
                serverId: account.serverId,
                serverUrl,
            });
            await flushHookEffects({ cycles: 4, turns: 2 });
        });
        await waitForTestEvent(hook.subscribe, hook.getCurrent, value => value.daemon?.route === 'relay_disabled');
        expect(hook.getCurrent().daemon?.route).toBe('relay_disabled');

        await act(async () => {
            expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, target, credentials)).toBe(true);
            notifyAuthCredentialsInvalidated({
                kind: 'credentials_removed',
                serverId: account.serverId,
                serverUrl,
            });
            await flushHookEffects({ cycles: 4, turns: 2 });
        });
        // Credential restoration resumes the real asynchronous Account bootstrap.
        await waitForTestEvent(hook.subscribe, hook.getCurrent, value => value.daemon?.route === 'direct');
        expect(hook.getCurrent().daemon?.route).toBe('direct');
    });
});
