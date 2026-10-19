import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import 'fake-indexeddb/auto';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import {
    resetSessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDisconnectedServerSocketBoundary();
const { Item } = await import('@/components/ui/lists/Item');
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

await vi.hoisted(async () => {
    const { installSessionSettingsEntryModuleMocks } = await import('./sessionSettingsEntryTestHelpers');
    installSessionSettingsEntryModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                TextInput: 'TextInput',
            });
        },
    });
});

// Cold route transformation is fixture preparation, not the mounted write deadline.
await import('@/app/(app)/settings/session/transcript');

afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
});

describe('Transcript settings (thinking display mode)', () => {
    it('renders the thinking display choices and updates session thinking mode + inline presentation', async () => {
        account = await createSecretSettingsTestHarness({ sharedEnabled: false, settings: settingsParse({
            sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'summary',
        }) });
        const mod = await import('@/app/(app)/settings/session/transcript');
        const credentials = account.credentials;
        const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
        const screen = await renderSettingsView(React.createElement(mod.default), { wrapper });

        const row = screen.findAllByType(Item).find(node => node.props.testID === 'settings-session-thinking-display');
        expect(row?.props.title).toBe('settingsSession.thinking.displayModeTitle');
        const tiles = row!.props.rightElement.props;
        expect(tiles.value).toBe('inline_summary');
        expect(tiles.options.map((option: { id: string }) => option.id)).toEqual(['inline_summary', 'inline_full', 'tool', 'hidden']);

        await act(async () => {
            tiles.onChange('inline_full');
        });

        await vi.waitFor(() => expect(account?.persistedSettings).toMatchObject({
            sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'full',
        }));
        expect(storage.getState().settings).toMatchObject({
            sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'full',
        });
        expect(account.settingsWrites).toHaveLength(1);
    });
});
