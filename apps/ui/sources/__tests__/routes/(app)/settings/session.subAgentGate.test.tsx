import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView as renderBaseSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorage = storage.getState();
let executionRunsEnabled = false;
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

installSessionSettingsEntryModuleMocks();
installDisconnectedServerSocketBoundary();

async function renderSettingsView(element: React.ReactElement) {
    account = await createSecretSettingsTestHarness({ settings: settingsParse({
        experiments: true, featureToggles: { 'execution.runs': executionRunsEnabled },
    }), sharedEnabled: false });
    const credentials = account.credentials;
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    return renderBaseSettingsView(element, { wrapper });
}



vi.mock('./sessionI18n', () => ({
    getPermissionApplyTimingSubtitleKey: () => 'x',
}));

// Load route graphs during collection; interaction deadlines measure the mounted contract.
await import('@/app/(app)/settings/session');

describe('Session settings (Sub-agent gate)', () => {
    afterEach(async () => {
        await standardCleanup();
        await account?.dispose();
        account = undefined;
        storage.setState(initialStorage, true);
        resetSessionSettingsEntryState();
        executionRunsEnabled = false;
    });

    it('does not render the Sub-agent section when execution runs are disabled', async () => {
        executionRunsEnabled = false;
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('subAgentGuidance.settings.rules.groupTitle')).toBeNull();
    });

    it('does not render the Subagents shortcut when execution runs are enabled', async () => {
        executionRunsEnabled = true;
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('subAgentGuidance.settings.rules.groupTitle')).toBeNull();
    });
});
