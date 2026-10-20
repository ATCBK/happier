import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import 'fake-indexeddb/auto';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let attentionPlacementMode: string = 'off';
let attentionStandingDefault: boolean = false;
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installSessionSettingsEntryModuleMocks();
installDisconnectedServerSocketBoundary();
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
    attentionPlacementMode = 'off';
    attentionStandingDefault = false;
    resetSessionSettingsEntryState();
});

async function renderStandingItem() {
    account = await createSecretSettingsTestHarness({ sharedEnabled: false, settings: settingsParse({
        sessionListAttentionPromotionModeV1: attentionPlacementMode,
        sessionListAttentionStandingDefaultV1: attentionStandingDefault,
    }) });
    const mod = await import('@/app/(app)/settings/session');
    const credentials = account.credentials;
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    const screen = await renderSettingsView(React.createElement(mod.default), { wrapper });
    return screen.findAllByType(Item).find((node: any) =>
        node.props?.testID === 'settings-session-attentionStandingDefault-item');
}

describe('Session settings attention standing default', () => {
    it('locks the switch and names the prerequisite while the attention band is off', async () => {
        attentionPlacementMode = 'off';

        const item = await renderStandingItem();

        expect(item).toBeTruthy();
        expect(item!.props.disabled).toBe(true);
        expect(item!.props.subtitle).toBe('settingsSession.sessionList.attentionStandingDefaultUnavailableSubtitle');
        expect(item!.props.rightElement?.props?.disabled).toBe(true);
    });

    it('enables the switch once the attention band has a placement and writes the account default', async () => {
        attentionPlacementMode = 'global';

        const item = await renderStandingItem();

        expect(item).toBeTruthy();
        expect(item!.props.disabled).toBe(false);
        expect(item!.props.subtitle).toBe('settingsSession.sessionList.attentionStandingDefaultDisabledSubtitle');
        expect(item!.props.rightElement?.props?.disabled).toBe(false);

        await act(async () => {
            item!.props.onPress();
        });

        await vi.waitFor(() => expect(account?.persistedSettings.sessionListAttentionStandingDefaultV1).toBe(true));
        expect(storage.getState().settings.sessionListAttentionStandingDefaultV1).toBe(true);
    });

    it('describes the enabled default when every session is kept', async () => {
        attentionPlacementMode = 'withinGroups';
        attentionStandingDefault = true;

        const item = await renderStandingItem();

        expect(item!.props.subtitle).toBe('settingsSession.sessionList.attentionStandingDefaultEnabledSubtitle');
        expect(item!.props.rightElement?.props?.value).toBe(true);
    });
});
