import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView as renderBaseSettingsView, standardCleanup } from '@/dev/testkit';
import 'fake-indexeddb/auto';
import { getCurrentAuth, InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { installSessionSettingsEntryModuleMocks } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    preferredLanguage: null as string | null,
    confirm: vi.fn(async () => true),
}));

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
// Locale transformation belongs to fixture preparation, not the confirmation/write contract.
const { preloadTranslationsForSettings, areTranslationsReadyForSettings } = await import('@/text/i18n');
await preloadTranslationsForSettings('fr');

async function renderSettingsView(element: React.ReactElement) {
    account = await createSecretSettingsTestHarness({ token: createAccountTokenForTests('account-a', { currentAccount: true }),
        sharedEnabled: false, settings: settingsParse({ preferredLanguage: shared.preferredLanguage }) });
    const credentials = account.credentials;
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    return renderBaseSettingsView(element, { wrapper });
}

afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
});

vi.mock('expo-localization', () => ({
    getLocales: () => [{ languageTag: 'fr-FR' }],
}));

vi.mock('@/hooks/inbox/useUpdates', () => ({
    useUpdates: () => ({ reloadApp: vi.fn() }),
}));

beforeEach(() => {
    standardCleanup();
    shared.preferredLanguage = 'de';
    shared.confirm.mockClear();
    installSessionSettingsEntryModuleMocks({
        textModule: async () => {
            const actual = await vi.importActual<typeof import('@/text')>('@/text');
            const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
            return {
                ...createTextModuleMock({ translate: (key) => key }),
                SUPPORTED_LANGUAGES: actual.SUPPORTED_LANGUAGES,
                SUPPORTED_LANGUAGE_CODES: actual.SUPPORTED_LANGUAGE_CODES,
                getLanguageNativeName: actual.getLanguageNativeName,
                getLanguageEnglishName: actual.getLanguageEnglishName,
            };
        },
        modalModule: async () => {
            const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
            return createModalModuleMock({ spies: { confirm: shared.confirm } }).module;
        },
    });
});

describe('Language settings', () => {
    it('offers the languages as one radio group with only the current language checked', async () => {
        const { default: LanguageSettingsScreen } = await import('@/app/(app)/settings/language');
        const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
        const { Item } = await import('@/components/ui/lists/Item');
        const screen = await renderSettingsView(React.createElement(LanguageSettingsScreen));

        const group = screen.findAllByType(ItemGroup).find((node) => node.props.accessibilityRole === 'radiogroup');
        expect(group).toBeTruthy();
        const radios = screen.findAllByType(Item).filter((node) => node.props.accessibilityRole === 'radio');
        expect(radios.length).toBeGreaterThan(2);
        expect(radios.filter((node) => node.props.accessibilityChecked === true).map((node) => node.props.title)).toEqual(['Deutsch']);
        // A language shown in its own name also says which language it is in the viewer's terms.
        expect(radios.find((node) => node.props.title === 'Deutsch')?.props.subtitle).toBe('German');
    });

    it('changes the language only after the restart is confirmed', async () => {
        const { default: LanguageSettingsScreen } = await import('@/app/(app)/settings/language');
        const { Item } = await import('@/components/ui/lists/Item');
        const screen = await renderSettingsView(React.createElement(LanguageSettingsScreen));

        const french = screen.findAllByType(Item).find((node) => node.props.title === 'Français');
        expect(getCurrentAuth()?.isAuthenticated).toBe(true);
        expect(areTranslationsReadyForSettings('fr')).toBe(true);
        expect(getActiveServerAccountScope()).toEqual(account?.scope);
        expect(storage.getState().settingsScope).toEqual(account?.scope);
        expect(french).toBeTruthy();
        const respond = account!.request.getMockImplementation();
        if (!respond) throw new Error('Settings HTTP fixture is unavailable');
        let publishWrite!: (response: Response) => void;
        const writeCompleted = new Promise<Response>(resolve => { publishWrite = resolve; });
        account!.request.mockImplementation(async (input, init) => {
            const response = await respond(input, init);
            if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method === 'POST') publishWrite(response);
            return response;
        });
        await screen.pressByTestIdAsync('settings-language-option-fr');

        expect(shared.confirm).toHaveBeenCalledTimes(1);
        // Language owns confirmation/reload and intentionally uses the incumbent
        // Settings writer (its generic declaration is read-only). The handler
        // has admitted the mutation. Its quiet-flush timer can leave the queue
        // idle initially, so observe the real HTTP write before queue completion.
        expect((await writeCompleted).ok).toBe(true);
        const { sync } = await import('@/sync/sync');
        const queue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
        expect(await queue.awaitQueue()).toEqual({ status: 'completed' });
        await vi.waitFor(() => expect(account?.persistedSettings.preferredLanguage).toBe('fr'));
        expect(storage.getState().settings.preferredLanguage).toBe('fr');
    });
});
