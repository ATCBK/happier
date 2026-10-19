import type {
    BrowserRecordingCapabilities,
    BrowserRecordingSessionV1,
} from '@happier-dev/protocol';
import { browserViewKey } from '@happier-dev/protocol';
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const machineRpcMock = vi.hoisted(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
}));
const nativeCaptureDisposers: Array<() => void> = [];
const modalSpies = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalSpies.alert } }).module;
});

vi.mock('@/sync/domains/browser/recording/machineRpc', () => ({
    startBrowserRecordingViaMachineRpc: (...args: readonly unknown[]) => machineRpcMock.start(...args),
    stopBrowserRecordingViaMachineRpc: (...args: readonly unknown[]) => machineRpcMock.stop(...args),
    cancelBrowserRecordingViaMachineRpc: (...args: readonly unknown[]) => machineRpcMock.cancel(...args),
}));

const recordingCapabilities = {
    enabled: true,
    attachmentsEnabled: true,
    available: true,
    supportedCaptureKinds: ['nativeViewCapture'],
    supportedMimeTypes: ['image/png'],
    supportedAdapterKinds: ['externalUrl'],
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
    maxFps: 12,
    audioSupported: false,
    cursorOverlaySupported: true,
    actionTimelineChaptersSupported: true,
    supportedRetentionClasses: ['preSend', 'attached'],
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

const streamRecordingCapabilities = {
    ...recordingCapabilities,
    supportedCaptureKinds: ['streamFrameCapture'],
    supportedMimeTypes: ['video/webm'],
    supportedAdapterKinds: ['localPreview'],
} satisfies BrowserRecordingCapabilities;

function recording(overrides: Partial<BrowserRecordingSessionV1> = {}): BrowserRecordingSessionV1 {
    return {
        v: 1,
        recordingId: 'recording_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        profileId: 'profile_1',
        targetKind: 'externalUrl',
        adapterKind: 'externalUrl',
        renderEngineKind: 'desktopWebView',
        captureKind: 'nativeViewCapture',
        fidelity: 'nativeCallback',
        startedAtMs: 10_000,
        status: 'recording',
        navigationGenerationStart: 2,
        durationMs: 0,
        byteSize: 0,
        frameCount: 0,
        fps: 12,
        mimeType: 'image/png',
        retentionClass: 'preSend',
        redactionLevel: 'metadataOnly',
        policyState: 'allowed',
        maxDurationMs: 30_000,
        maxBytes: 16_000_000,
        actionChapters: [],
        relatedReferences: [],
        ...overrides,
    };
}

async function registerNativeCaptureHandler(machineId = 'machine_1'): Promise<void> {
    const { registerDesktopBrowserRecordingReverseCaptureHandler } = await import(
        '@/sync/domains/browser/recording/reverseCaptureAvailability'
    );
    nativeCaptureDisposers.push(registerDesktopBrowserRecordingReverseCaptureHandler(machineId));
}

describe('session browser recording runtime', () => {
    afterEach(() => {
        standardCleanup();
        while (nativeCaptureDisposers.length > 0) {
            nativeCaptureDisposers.pop()?.();
        }
        machineRpcMock.start.mockReset();
        machineRpcMock.stop.mockReset();
        machineRpcMock.cancel.mockReset();
        modalSpies.alert.mockReset();
    });

    it('starts recording through the daemon machine RPC and shares the returned session state', async () => {
        await registerNativeCaptureHandler();
        machineRpcMock.start.mockResolvedValueOnce({
            ok: true,
            result: { status: 'started', recording: recording() },
        });
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'server_1',
                recordingCapabilities,
                nowMs: () => 10_000,
            });
            return (
                <View>
                    <Text testID="recording-mounted">{runtime?.browserShellRecording ? 'yes' : 'no'}</Text>
                    <Text testID="active-recording-id">
                        {runtime?.state.activeRecordingIdByViewId.view_1 ?? 'none'}
                    </Text>
                    <Pressable
                        testID="start-recording"
                        onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                            browserSessionId: 'browser_session_1',
                            viewId: 'view_1',
                            profileId: 'profile_1',
                            target: {
                                kind: 'externalUrl',
                                targetId: 'external_1',
                                url: 'https://example.com/',
                            },
                            targetKind: 'externalUrl',
                            adapterKind: 'externalUrl',
                            renderEngineKind: 'desktopWebView',
                            captureKind: 'nativeViewCapture',
                            fidelity: 'nativeCallback',
                            navigationGeneration: 2,
                            mimeType: 'image/png',
                            retentionClass: 'preSend',
                            policyState: 'allowed',
                        })}
                    />
                </View>
            );
        }

        const screen = await renderScreen(<Probe />);

        expect(screen.findByTestId('recording-mounted')?.props.children).toBe('yes');
        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('none');

        await screen.pressByTestIdAsync('start-recording');

        expect(machineRpcMock.start).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            signal: expect.any(AbortSignal),
            input: expect.objectContaining({
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                mediaTarget: {
                    sessionId: 'session_1',
                    messageLocalId: 'browser-recording-view_1-10000',
                },
            }),
        });
        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('recording_1');
    });

    it('deduplicates concurrent start requests for the same browser view', async () => {
        await registerNativeCaptureHandler();
        machineRpcMock.start.mockReturnValue(new Promise(() => undefined));
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'server_1',
                recordingCapabilities,
                nowMs: () => 10_000,
            });
            const request = {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                profileId: 'profile_1',
                target: {
                    kind: 'externalUrl',
                    targetId: 'external_1',
                    url: 'https://example.com/',
                },
                targetKind: 'externalUrl',
                adapterKind: 'externalUrl',
                renderEngineKind: 'desktopWebView',
                captureKind: 'nativeViewCapture',
                fidelity: 'nativeCallback',
                navigationGeneration: 2,
                mimeType: 'image/png',
                retentionClass: 'preSend',
                policyState: 'allowed',
            } as const;
            return (
                <Pressable
                    testID="start-recording"
                    onPress={() => runtime?.browserShellRecording.onStartRecording?.(request)}
                />
            );
        }

        const screen = await renderScreen(<Probe />);

        screen.pressByTestId('start-recording');
        screen.pressByTestId('start-recording');

        expect(machineRpcMock.start).toHaveBeenCalledTimes(1);
    });

    it('does not mark a recording active when daemon start fails closed', async () => {
        await registerNativeCaptureHandler();
        machineRpcMock.start.mockResolvedValueOnce({ ok: false, reason: 'request_failed' });
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'server_1',
                recordingCapabilities,
                nowMs: () => 10_000,
            });
            return (
                <View>
                    <Text testID="active-recording-id">
                        {runtime?.state.activeRecordingIdByViewId.view_1 ?? 'none'}
                    </Text>
                    <Pressable
                        testID="start-recording"
                        onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                            browserSessionId: 'browser_session_1',
                            viewId: 'view_1',
                            profileId: 'profile_1',
                            target: {
                                kind: 'externalUrl',
                                targetId: 'external_1',
                                url: 'https://example.com/',
                            },
                            targetKind: 'externalUrl',
                            adapterKind: 'externalUrl',
                            renderEngineKind: 'desktopWebView',
                            captureKind: 'nativeViewCapture',
                            fidelity: 'nativeCallback',
                            navigationGeneration: 2,
                            mimeType: 'image/png',
                            retentionClass: 'preSend',
                            policyState: 'allowed',
                        })}
                    />
                </View>
            );
        }

        const screen = await renderScreen(<Probe />);

        await screen.pressByTestIdAsync('start-recording');

        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('none');
    });

    it('does not call the daemon for stream-frame recording when no capture source is resolvable', async () => {
        const onUnavailable = vi.fn();
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'server_1',
                recordingCapabilities: streamRecordingCapabilities,
                nowMs: () => 10_000,
                onUnavailable,
            });
            return (
                <Pressable
                    testID="start-recording"
                    onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                        profileId: 'profile_1',
                        target: {
                            kind: 'localServicePreview',
                            targetId: 'local_preview_1',
                            sessionId: 'session_1',
                            machineId: 'machine_1',
                        },
                        targetKind: 'localServicePreview',
                        adapterKind: 'localPreview',
                        renderEngineKind: 'webIframe',
                        captureKind: 'streamFrameCapture',
                        fidelity: 'streamFrame',
                        navigationGeneration: 2,
                        mimeType: 'video/webm',
                        retentionClass: 'preSend',
                        policyState: 'allowed',
                    })}
                />
            );
        }

        const screen = await renderScreen(<Probe />);

        await screen.pressByTestIdAsync('start-recording');

        expect(machineRpcMock.start).not.toHaveBeenCalled();
        expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'browser_recording_capture_unavailable',
        }));
    });

    it('does not call the daemon for native view recording when no reverse-capture handler is registered', async () => {
        machineRpcMock.start.mockResolvedValueOnce({ ok: false, reason: 'unexpected_start' });
        const onUnavailable = vi.fn();
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'server_1',
                recordingCapabilities,
                nowMs: () => 10_000,
                onUnavailable,
            });
            return (
                <Pressable
                    testID="start-recording"
                    onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                        profileId: 'profile_1',
                        target: {
                            kind: 'externalUrl',
                            targetId: 'external_1',
                            url: 'https://example.com/',
                        },
                        targetKind: 'externalUrl',
                        adapterKind: 'externalUrl',
                        renderEngineKind: 'desktopWebView',
                        captureKind: 'nativeViewCapture',
                        fidelity: 'nativeCallback',
                        navigationGeneration: 2,
                        mimeType: 'image/png',
                        retentionClass: 'preSend',
                        policyState: 'allowed',
                    })}
                />
            );
        }

        const screen = await renderScreen(<Probe />);

        await screen.pressByTestIdAsync('start-recording');

        expect(machineRpcMock.start).not.toHaveBeenCalled();
        expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'browser_recording_capture_unavailable',
        }));
    });

    it.each(['simulatorPreview', 'streamedBrowser'] as const)('uses %s producer source identity for stream-frame recording', async (targetKind) => {
        machineRpcMock.start.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'started',
                recording: recording({
                    targetKind,
                    adapterKind: targetKind === 'simulatorPreview' ? 'simulatorPreview' : 'streamedBrowserSurface',
                    renderEngineKind: 'streamedSurface',
                    captureKind: 'streamFrameCapture',
                    fidelity: 'streamFrame',
                    mimeType: 'video/webm',
                }),
            },
        });
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'server_1',
                recordingCapabilities: {
                    ...streamRecordingCapabilities,
                    supportedAdapterKinds: ['simulatorPreview', 'streamedBrowserSurface'],
                },
                nowMs: () => 10_000,
            });
            return (
                <Pressable
                    testID="start-recording"
                    onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                        profileId: 'profile_1',
                        target: targetKind === 'simulatorPreview' ? {
                            kind: 'simulatorPreview',
                            targetId: 'simulator_1',
                            deviceId: 'emulator-5554',
                            sourceId: 'simulator:android:emulator-5554:screen',
                        } : { kind: 'streamedBrowser', targetId: 'daemon-view', streamId: 'viewer-specific-stream' },
                        targetKind,
                        adapterKind: targetKind === 'simulatorPreview' ? 'simulatorPreview' : 'streamedBrowserSurface',
                        renderEngineKind: 'streamedSurface',
                        captureKind: 'streamFrameCapture',
                        fidelity: 'streamFrame',
                        navigationGeneration: 2,
                        mimeType: 'video/webm',
                        retentionClass: 'preSend',
                        policyState: 'allowed',
                    })}
                />
            );
        }

        const screen = await renderScreen(<Probe />);

        await screen.pressByTestIdAsync('start-recording');

        expect(machineRpcMock.start).toHaveBeenCalledWith(expect.objectContaining({
            input: expect.objectContaining({
                captureSource: {
                    kind: 'machineLiveStream',
                    streamFamily: targetKind === 'simulatorPreview' ? 'simulator:android:emulator-5554:screen' : 'browser.streamed',
                    sourceId: targetKind === 'simulatorPreview' ? 'simulator:android:emulator-5554:screen'
                        : browserViewKey({ browserSessionId: 'browser_session_1', viewId: 'view_1' }),
                    targetMachineId: 'machine_1',
                },
            }),
        }));
    });

    it('surfaces daemon unavailable start responses instead of leaving the UI idle', async () => {
        await registerNativeCaptureHandler();
        machineRpcMock.start.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'unavailable',
                reason: {
                    code: 'browser_recording_capture_unavailable',
                    message: 'Browser recording capture requires a live stream source.',
                },
            },
        });
        const onUnavailable = vi.fn();
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'server_1',
                recordingCapabilities,
                nowMs: () => 10_000,
                onUnavailable,
            });
            return (
                <View>
                    <Text testID="active-recording-id">
                        {runtime?.state.activeRecordingIdByViewId.view_1 ?? 'none'}
                    </Text>
                    <Pressable
                        testID="start-recording"
                        onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                            browserSessionId: 'browser_session_1',
                            viewId: 'view_1',
                            profileId: 'profile_1',
                            target: {
                                kind: 'externalUrl',
                                targetId: 'external_1',
                                url: 'https://example.com/',
                            },
                            targetKind: 'externalUrl',
                            adapterKind: 'externalUrl',
                            renderEngineKind: 'desktopWebView',
                            captureKind: 'nativeViewCapture',
                            fidelity: 'nativeCallback',
                            navigationGeneration: 2,
                            mimeType: 'image/png',
                            retentionClass: 'preSend',
                            policyState: 'allowed',
                        })}
                    />
                </View>
            );
        }

        const screen = await renderScreen(<Probe />);

        await screen.pressByTestIdAsync('start-recording');

        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('none');
        expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'browser_recording_capture_unavailable',
            message: 'Browser recording capture requires a live stream source.',
        }));
    });
    async function renderActiveRecordingProbe(): Promise<Awaited<ReturnType<typeof renderScreen>>> {
        await registerNativeCaptureHandler();
        machineRpcMock.start.mockResolvedValueOnce({
            ok: true,
            result: { status: 'started', recording: recording() },
        });
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'server_1',
                recordingCapabilities,
                nowMs: () => 10_000,
            });
            const active = runtime?.state.sessionsById.recording_1 ?? null;
            return (
                <View>
                    <Text testID="active-recording-id">
                        {runtime?.state.activeRecordingIdByViewId.view_1 ?? 'none'}
                    </Text>
                    <Pressable
                        testID="start-recording"
                        onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                            browserSessionId: 'browser_session_1',
                            viewId: 'view_1',
                            profileId: 'profile_1',
                            target: {
                                kind: 'externalUrl',
                                targetId: 'external_1',
                                url: 'https://example.com/',
                            },
                            targetKind: 'externalUrl',
                            adapterKind: 'externalUrl',
                            renderEngineKind: 'desktopWebView',
                            captureKind: 'nativeViewCapture',
                            fidelity: 'nativeCallback',
                            navigationGeneration: 2,
                            mimeType: 'image/png',
                            retentionClass: 'preSend',
                            policyState: 'allowed',
                        })}
                    />
                    <Pressable
                        testID="stop-recording"
                        onPress={() => { if (active) void runtime?.browserShellRecording.onStopRecording?.(active); }}
                    />
                    <Pressable
                        testID="cancel-recording"
                        onPress={() => { if (active) void runtime?.browserShellRecording.onCancelRecording?.(active); }}
                    />
                </View>
            );
        }

        const screen = await renderScreen(<Probe />);
        await screen.pressByTestIdAsync('start-recording');
        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('recording_1');
        return screen;
    }

    it('tells the user when stopping a recording fails instead of failing silently (H-UX F-4)', async () => {
        const screen = await renderActiveRecordingProbe();
        machineRpcMock.stop.mockResolvedValueOnce({ ok: false, errorCode: 'rpc_unavailable', error: 'rpc_unavailable' });

        await screen.pressByTestIdAsync('stop-recording');

        const { t } = await import('@/text');
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
        expect(modalSpies.alert.mock.calls[0]?.[0]).toBe(t('browserRecording.failure.stopTitle'));
        // Nothing changed, so the recording is still the active one.
        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('recording_1');
    });

    it('tells the user when discarding a recording is refused by the daemon', async () => {
        const screen = await renderActiveRecordingProbe();
        machineRpcMock.cancel.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'unavailable',
                reason: { code: 'browser_recording_capture_unavailable', message: 'capture adapter gone' },
            },
        });

        await screen.pressByTestIdAsync('cancel-recording');

        const { t } = await import('@/text');
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
        expect(modalSpies.alert.mock.calls[0]?.[0]).toBe(t('browserRecording.failure.discardTitle'));
        // The daemon's technical message is never shown raw.
        expect(String(modalSpies.alert.mock.calls[0]?.[1])).not.toContain('capture adapter gone');
    });

    it('stays quiet when stop succeeds: the recording state changing is the outcome', async () => {
        const screen = await renderActiveRecordingProbe();
        machineRpcMock.stop.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'finalized',
                recording: recording({
                    status: 'finalized',
                    outcomeReason: 'user_stopped',
                    stoppedAtMs: 12_000,
                    mediaRef: { refKind: 'sessionMedia', mediaId: 'media_1', mediaKind: 'video', mimeType: 'video/webm', sizeBytes: 2048 },
                }),
            },
        });

        await screen.pressByTestIdAsync('stop-recording');

        expect(modalSpies.alert).not.toHaveBeenCalled();
    });
});
