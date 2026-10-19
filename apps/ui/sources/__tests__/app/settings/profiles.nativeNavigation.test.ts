import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { renderInCollectionLayout, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installProfilesCommonModuleMocks } from '@/components/profiles/profilesTestHelpers';
import { PROFILE_ROWS_ROUTE_V1, ProfileRecordV1Schema, ProfileRowsListResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
import type { ProfilesListProps } from '@/components/profiles/ProfilesList';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary();
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

const savedProfile = {
    v: 2 as const,
    id: 'p1',
    name: 'Test profile',
    extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {},
    defaultPersistenceModeByTargetKey: {},
    compatibilityByTargetKey: {},
    createdAt: 1,
    updatedAt: 1,
};
const settingsState = vi.hoisted(() => ({
    values: {} as Record<string, unknown>,
}));

installProfilesCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }),
    storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
});

const routerMock = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock();
    routerMock.push = expoRouterMock.spies.push;
    routerMock.replace = expoRouterMock.spies.replace;
    return expoRouterMock.module;
});

function resetSettings(overrides: Record<string, unknown> = {}) {
    settingsState.values = {
        useProfiles: true,
        profiles: [savedProfile],
        favoriteProfiles: [],
        profileEnabledById: {},
        providerSettingsV1: null,
        currentSecretBindingsByProfileId: {},
        lastUsedProfile: null,
        ...overrides,
    };
}

async function renderIndex(mode: 'split' | 'stacked' | null) {
    const { profiles, ...preferences } = settingsState.values;
    account = await createSecretSettingsTestHarness({ settings: settingsParse(preferences), sharedEnabled: false });
    const records = (Array.isArray(profiles) ? profiles : []).map((profile: unknown) => {
        if (!profile || typeof profile !== 'object' || !('id' in profile)) throw new Error('Missing navigation Profile identity');
        return ProfileRecordV1Schema.parse({ v: 1, id: profile.id, definition: { kind: 'inline', profile },
            enabled: true, promptStack: [], secretBindings: {} });
    });
    const transfer = ProfileTransferRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, phase: 'active', sourceSettingsVersion: 1, migratedLogicalRevision: 1,
            inventory: records.map(record => ({ kind: 'account_row', id: record.id, revision: 1 })) } } });
    account.catalogRows.set(PROFILE_TRANSFER_ROUTE_V1, transfer);
    account.catalogRows.set(PROFILE_ROWS_ROUTE_V1, ProfileRowsListResponseV1Schema.parse({ status: 'listed',
        rows: records.map(record => ({ id: record.id, revision: 1, content: { t: 'plain', v: record } })),
        nextCursor: null, complete: true, referenceGuardRevision: 3, transferControl: transfer, diagnostics: [] }));
    const { ProfileSettingsIndex } = await import('@/components/settings/profiles/ProfileSettingsIndex');
    const { ProfilesList } = await import('@/components/profiles/ProfilesList');
    routerMock.push.mockClear();
    const screen = await renderInCollectionLayout(
        React.createElement(InjectedAuthProvider, {
            credentials: account.credentials,
            children: React.createElement(ProfileSettingsIndex),
        }),
        mode,
    );
    // react-test-renderer erases the public component props at its SDK boundary.
    const listProps = (): ProfilesListProps | null => screen.findAllByType(ProfilesList).at(0)?.props as ProfilesListProps | undefined ?? null;
    return { ...screen, listProps };
}

afterEach(async () => {
    await standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
});

describe('Settings › Profiles collection list', () => {
    it('adds a profile as a draft in the collection', async () => {
        resetSettings();
        const screen = await renderIndex('stacked');

        await screen.pressByTestIdAsync('profiles-list-add-profile');

        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith('/settings/profiles/new');
    });

    it('opens a profile, and a copy of one, in the collection instead of an inline or new-session editor', async () => {
        resetSettings();
        const screen = await renderIndex('stacked');
        const profile = screen.listProps()?.customProfiles.find(profile => profile.id === savedProfile.id);
        expect(profile).toBeDefined();
        if (!profile) throw new Error('The real Profile collection did not load its saved row');

        await act(async () => {
            screen.listProps()?.onEditProfile?.(profile);
        });
        await screen.pressByTestIdAsync('profiles-list-row:p1');
        await act(async () => {
            screen.listProps()?.onDuplicateProfile?.(profile);
        });

        expect(routerMock.push.mock.calls).toEqual([
            ['/settings/profiles/p1'],
            ['/settings/profiles/p1'],
            ['/settings/profiles/new?cloneFrom=p1'],
        ]);
    });

    it('keeps Default Environment visible as the first-class no-profile choice, with its own detail', async () => {
        resetSettings();
        const screen = await renderIndex('stacked');

        expect(screen.listProps()?.includeDefaultEnvironmentRow).toBe(true);
        await screen.pressByTestIdAsync('profiles-list-row:default-environment');
        expect(routerMock.push).toHaveBeenCalledWith('/settings/profiles/default-environment');
    });

    it('lands on a profile beside the rail instead of an empty detail', async () => {
        resetSettings();
        const screen = await renderIndex('split');

        const redirects = screen.findAll((node) => String(node.type) === 'Redirect');
        expect(redirects).toHaveLength(1);
        expect(redirects[0]?.props.href).toBe('/settings/profiles/p1');
        expect(screen.listProps()).toBeNull();
    });

    it('lands on the no-profile choice, not a blank draft, when there is no profile to show', async () => {
        resetSettings({ profiles: [] });
        const screen = await renderIndex('split');

        const redirects = screen.findAll((node) => String(node.type) === 'Redirect');
        expect(redirects.map((node) => node.props.href)).toEqual(['/settings/profiles/default-environment']);
    });

    it('shows only the switch that turns profiles on while they are off', async () => {
        resetSettings({ useProfiles: false });
        const screen = await renderIndex('split');

        expect(screen.findAll((node) => String(node.type) === 'Redirect')).toHaveLength(0);
        expect(screen.listProps()).toBeNull();
        expect(screen.findByTestId('settings.profiles.useProfiles')).not.toBeNull();
    });
});
