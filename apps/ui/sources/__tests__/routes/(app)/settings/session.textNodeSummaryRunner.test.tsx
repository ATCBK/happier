import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    collectUnexpectedRawTextNodes,
} from '@/dev/testkit/render/renderScreen';
import { renderScreen as renderBaseScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { LlmTaskRunnerConfigV1BackendModelPicker } from '@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingsState: Record<string, any> = {
    sessionReplayEnabled: true,
    sessionReplayStrategy: 'summary_plus_recent',
    sessionReplayRecentMessagesCount: 100,
    sessionReplayMaxSeedChars: 50_000,
    sessionReplaySummaryRunnerV1: null,
    sessionUseTmux: false,
    sessionTmuxSessionName: null,
    sessionTmuxIsolated: false,
    sessionTmuxTmpDir: null,
    sessionMessageSendMode: 'agent_queue',
    sessionBusySteerSendPolicy: 'server_pending',
    agentInputEnterToSend: true,
    agentInputHistoryScope: 'perSession',
    terminalConnectLegacySecretExportEnabled: false,
    sessionTagsEnabled: true,
    sessionsRightPaneDefaultOpen: false,
    uiMultiPanePanelsEnabled: false,
};

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            TextInput: 'TextInput',
            ScrollView: 'ScrollView',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
            Dimensions: {
                get: () => ({ width: 1440, height: 900 }),
            },
        });
    },
});
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/components/settings/pickers/resolvePreferredMachineId', () => ({
    resolvePreferredMachineId: () => null,
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        modelOptions: [],
        probe: { phase: 'idle', refresh: vi.fn() },
    }),
}));

sessionSettingsEntryState.settingsState = settingsState;

afterEach(async () => {
    await standardCleanup();
    await account?.dispose();
    account = undefined;
    resetSessionSettingsEntryState();
});

describe('Session resume settings (summary runner text-node guard)', () => {
    it('does not emit raw text nodes under non-Text parents when summary runner controls are visible', async () => {
        const mod = await import('@/app/(app)/settings/session/resume');
        const SessionResumeSettingsScreen = mod.default;

        account = await createSecretSettingsTestHarness({ settings: settingsParse({
            ...settingsState, experiments: true, featureToggles: { 'execution.runs': true },
        }), sharedEnabled: false });
        const screen = await renderBaseScreen(React.createElement(SessionResumeSettingsScreen));
        expect(screen.findAllByType(LlmTaskRunnerConfigV1BackendModelPicker)).toHaveLength(1);
        const badNodes = collectUnexpectedRawTextNodes(screen.tree.toJSON());
        expect(badNodes).toEqual([]);
    });
});
