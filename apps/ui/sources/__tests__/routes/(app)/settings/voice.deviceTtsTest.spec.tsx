import React from 'react';
import 'fake-indexeddb/auto';
import type { SpeechOptions } from 'expo-speech';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import {
    readLocalConversationVoiceSettings, readLocalDirectVoiceSettings, voiceSettingsDefaults,
    writeLocalConversationVoiceSettings, writeLocalDirectVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storage';
import { ModalProvider } from '@/modal';
import { t } from '@/text';

const speech = vi.hoisted(() => ({ texts: [] as string[], failure: null as Error | null }));
vi.mock('expo-speech', () => ({
    speak(text: string, options: SpeechOptions) {
        speech.texts.push(text);
        if (speech.failure) options.onError?.(speech.failure);
        else { options.onStart?.(); options.onDone?.(); }
    },
    stop: vi.fn(),
    getAvailableVoicesAsync: async () => [],
}));
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// React-test-renderer supplies the native/portal host; modal lifecycle remains real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
installDisconnectedServerSocketBoundary();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const originalState = storage.getState();
const { VoiceConversationsSettingsScreen } = await import('@/voice/settings/screens/VoiceConversationsSettingsScreen');
beforeEach(() => {
    // Test Renderer presses do not create the browser's trusted activation fact.
    vi.stubGlobal('navigator', { userActivation: { isActive: true, hasBeenActive: true } });
});
afterEach(() => {
    standardCleanup(); storage.setState(originalState, true); speech.texts = []; speech.failure = null;
    vi.unstubAllGlobals();
});

function deviceVoice(providerId: 'local_direct' | 'local_conversation') {
    if (providerId === 'local_direct') {
        const local = readLocalDirectVoiceSettings(voiceSettingsDefaults);
        return { ...writeLocalDirectVoiceSettings(voiceSettingsDefaults, { ...local, tts: { ...local.tts, provider: 'device' } }), providerId };
    }
    const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    return { ...writeLocalConversationVoiceSettings(voiceSettingsDefaults, {
        ...local, conversationMode: 'agent', tts: { ...local.tts, provider: 'device' },
    }), providerId };
}

describe('VoiceSettingsScreen (device TTS)', () => {
    it.each(['local_direct', 'local_conversation'] as const)(
        'speaks the %s sample through real settings admission and the device engine without a Base URL', async providerId => {
            const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: deviceVoice(providerId) }));
            try {
                const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}><ModalProvider><VoiceConversationsSettingsScreen /></ModalProvider></InjectedAuthProvider>);
                const row = screen.findRowByTitle(t('settingsVoice.local.testTts'));
                expect(row).toBeTruthy();
                await act(async () => row!.props.rightElement.props.onPress());
                await vi.waitFor(() => expect(speech.texts).toEqual([t('settingsVoice.local.testTtsSample')]));
                expect(screen.findAllHostsByTestId('web-modal-button-0')).toHaveLength(0);
            } finally { standardCleanup(); await account.dispose(); }
        });
    it('shows the real device speech failure instead of reporting a missing Base URL', async () => {
        speech.failure = new Error('device failed');
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: deviceVoice('local_direct') }));
        try {
            const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}><ModalProvider><VoiceConversationsSettingsScreen /></ModalProvider></InjectedAuthProvider>);
            const row = screen.findRowByTitle(t('settingsVoice.local.testTts'));
            expect(row).toBeTruthy();
            await act(async () => row!.props.rightElement.props.onPress());
            await vi.waitFor(() => expect(speech.texts).toEqual([t('settingsVoice.local.testTtsSample')]));
            await vi.waitFor(() => expect(screen.findHostByTestId('web-modal-button-0')).toBeTruthy());
            expect(screen.getTextContent()).toContain(t('common.error'));
            expect(screen.getTextContent()).toContain(t('settingsVoice.local.testTtsFailed'));
            expect(screen.getTextContent()).not.toContain(t('settingsVoice.local.testTtsMissingBaseUrl'));
        } finally { standardCleanup(); await account.dispose(); }
    });
});
