import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1280, height: 800 }),
            Platform: {
                OS: 'ios',
                select: (v: any) => v.ios ?? v.default ?? null,
            },
        });
    },
});

sessionSettingsEntryState.settingsState = {
    agentInputEnterToSend: false,
    agentInputEnterToSendNative: true,
    agentInputHistoryScope: 'perSession',
    sessionMessageSendMode: 'agent_queue',
    sessionBusySteerSendPolicy: 'steer_immediately',
    terminalConnectLegacySecretExportEnabled: false,
    sessionReplayEnabled: false,
    sessionReplayStrategy: 'recent_messages',
    sessionReplayRecentMessagesCount: 100,
    sessionUseTmux: false,
    sessionTmuxSessionName: null,
    sessionTmuxIsolated: false,
    sessionTmuxTmpDir: null,
    sessionsRightPaneDefaultOpen: false,
    uiMultiPanePanelsEnabled: true,
};
const initialStorage = storage.getState();

afterEach(() => {
    standardCleanup();
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
});

describe('Session settings (native enter-to-send)', () => {
    it('binds Enter-to-send to the native setting on native platforms', async () => {
        storage.setState({ settings: settingsParse(sessionSettingsEntryState.settingsState) });
        const mod = await import('@/app/(app)/settings/session/composer');
        const SessionComposerSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsScreen));

        const items = screen.findAllByType(Item);
        // The row is the declared Composer › Typing setting (`SettingRow`), titled from its declaration.
        const enterToSendItem = items.find((item) => item.props?.testID === 'settings-composer-enter-to-send');
        expect(enterToSendItem?.props?.title).toBe('settingsSessionPages.composer.enterToSendTitle');

        expect(enterToSendItem).toBeTruthy();
        expect(enterToSendItem?.props?.subtitle).toBe('settingsSession.inputBehavior.enterToSendEnabledNativeSubtitle');
        expect(enterToSendItem?.props?.showChevron).toBe(false);
        expect(enterToSendItem?.props?.rightElement?.props?.value).toBe(true);
    });
});
