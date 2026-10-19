import React from 'react';
import { vi } from 'vitest';

import type { ExpoRouterParams } from '@/dev/testkit/mocks/router';
import type { AcpCatalogRecordV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

type ModuleFactory = () => unknown | Promise<unknown>;

/** Load the real owners during collection, outside a test or hook deadline. */
export function loadProfileEditFormCatalogFixtureOwners() {
    return Promise.all([
        import('@/sync/domains/state/storageStore'),
        import('@/sync/domains/server/serverProfiles'),
        import('@/sync/store/settings/acpCatalogSnapshot'),
        import('@/sync/store/settings/profileCatalogSnapshot'),
        import('@/sync/engine/settings/acpCatalogEngine'),
    ]);
}

/** Existing legacy editors capture their acknowledged row and private attachments. */
export async function publishProfileEditFormPrivateRowFixture(profile: AIBackendProfile) {
    const [{ getStorage }, , , profiles] = await loadProfileEditFormCatalogFixtureOwners();
    const scope = getStorage().getState().settingsScope;
    if (!scope) throw new Error('Profile fixture requires a scoped catalog');
    const { profileRecordRevision: _revision, ...definition } = profile as AIBackendProfile & { profileRecordRevision?: number };
    const record = ProfileRecordV1Schema.parse({ v: 1, id: profile.id,
        definition: { kind: 'legacy', profile: definition }, enabled: true, promptStack: [], secretBindings: {} });
    profiles.resetProfileCatalogSnapshotsForTests();
    profiles.applyProfileCatalogSnapshot(scope, { status: 'ready', source: 'destination', authority: 'active', records: [{ record, revision: 1 }],
        control: null, controlRevision: 'absent', referenceGuardRevision: 'absent', diagnostics: [] }, true);
    return () => profiles.resetProfileCatalogSnapshotsForTests();
}

/** Publishes the real scoped row; Settings mocks do not supply catalog authority. */
export async function publishProfileEditFormAcpCatalogFixture(record: AcpCatalogRecordV1) {
    const [{ getStorage }, { getActiveServerId }, catalog, , engine] = await loadProfileEditFormCatalogFixtureOwners();
    const previousScope = getStorage().getState().settingsScope;
    const scope = { serverId: getActiveServerId(), accountId: 'profile-editor-fixture' };
    engine.resetAcpCatalogEngineForTests();
    catalog.resetAcpCatalogSnapshotsForTests();
    getStorage().setState({ settingsScope: scope });
    catalog.applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record }, true);
    return () => {
        engine.resetAcpCatalogEngineForTests();
        catalog.resetAcpCatalogSnapshotsForTests();
        getStorage().setState({ settingsScope: previousScope });
    };
}

type InstallProfileEditFormModuleMocksOptions = Readonly<{
    reactNative?: ModuleFactory;
    storageModule?: ModuleFactory;
    routeParams?: ExpoRouterParams;
}>;

const profileEditFormTestState = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    routerBackSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    routerSetParamsSpy: vi.fn(),
    navigationSetOptionsSpy: vi.fn(),
    modalShowSpy: vi.fn(),
    modalAlertSpy: vi.fn(),
    options: {
        reactNative: undefined as ModuleFactory | undefined,
        storageModule: undefined as ModuleFactory | undefined,
        routeParams: {} as ExpoRouterParams,
    },
}));

export function resetProfileEditFormTestState() {
    profileEditFormTestState.routerPushSpy.mockReset();
    profileEditFormTestState.routerBackSpy.mockReset();
    profileEditFormTestState.routerReplaceSpy.mockReset();
    profileEditFormTestState.routerSetParamsSpy.mockReset();
    profileEditFormTestState.navigationSetOptionsSpy.mockReset();
    profileEditFormTestState.modalShowSpy.mockReset();
    profileEditFormTestState.modalAlertSpy.mockReset();
    profileEditFormTestState.options = {
        reactNative: undefined,
        storageModule: undefined,
        routeParams: {},
    };
}

export function installProfileEditFormModuleMocks(
    options: InstallProfileEditFormModuleMocksOptions = {},
) {
    profileEditFormTestState.options = {
        reactNative: options.reactNative,
        storageModule: options.storageModule,
        routeParams: options.routeParams ?? {},
    };

    vi.mock('@/text', async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('react-native', async () => {
        if (profileEditFormTestState.options.reactNative) {
            return await profileEditFormTestState.options.reactNative();
        }
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('expo-router', async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: profileEditFormTestState.routerPushSpy,
                back: profileEditFormTestState.routerBackSpy,
                replace: profileEditFormTestState.routerReplaceSpy,
                setParams: profileEditFormTestState.routerSetParamsSpy,
            },
            navigation: {
                setOptions: profileEditFormTestState.navigationSetOptionsSpy,
            },
            params: () => profileEditFormTestState.options.routeParams,
        }).module;
    });

    vi.mock('react-native-unistyles', async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/modal', async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (...args: unknown[]) => profileEditFormTestState.modalShowSpy(...args),
                alert: (...args: unknown[]) => profileEditFormTestState.modalAlertSpy(...args),
            },
        }).module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        if (profileEditFormTestState.options.storageModule) {
            return await profileEditFormTestState.options.storageModule();
        }
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: () => ({}),
            useSettings: () => ({}),
            useAllMachines: () => [],
            useMachine: () => null,
            useSettingMutable: () => [[], vi.fn()] as const,
        });
    });

    vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
        MachineSelector: () => null,
    }));


    vi.mock('@/components/profiles/environmentVariables/EnvironmentVariablesList', () => ({
        EnvironmentVariablesList: () => null,
    }));

    vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
        DropdownMenu: () => null,
    }));

    vi.mock('@/components/ui/lists/ItemList', () => ({
        ItemList: ({ children }: { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
    }));

    vi.mock('@/components/ui/lists/ItemGroup', () => ({
        ItemGroup: ({ children }: { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
        ItemGroupSelectionContext: React.createContext<{ selectableItemCount: number } | null>(null),
    }));

    vi.mock('@/components/ui/forms/Switch', () => ({
        Switch: () => null,
    }));

    vi.mock('@/utils/sessions/machineUtils', () => ({
        isMachineOnline: () => true,
    }));

    vi.mock('@/sync/domains/profiles/profileUtils', () => ({
        getBuiltInProfileDocumentation: () => null,
    }));

    vi.mock('@/sync/domains/permissions/permissionTypes', () => ({
        normalizeProfileDefaultPermissionMode: <T,>(value: T) => value,
    }));

    vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
        getPermissionModeLabelForAgentType: () => '',
        getPermissionModeOptionsForAgentType: () => [],
        normalizePermissionModeForAgentType: <T,>(value: T) => value,
    }));

    vi.mock('@/components/ui/layout/layout', () => ({
        layout: { maxWidth: 900 },
        useLayoutMaxWidth: () => 900,
        useLayoutMaxWidthStyle: () => ({ maxWidth: 900 }),
    }));

    vi.mock('@/utils/profiles/envVarTemplate', () => ({
        parseEnvVarTemplate: () => ({ variables: [] }),
    }));

    vi.mock('@/components/secrets/requirements', () => ({
        SecretRequirementModal: () => null,
    }));
}

export { profileEditFormTestState };
