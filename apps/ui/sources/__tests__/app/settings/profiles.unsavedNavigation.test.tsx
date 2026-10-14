import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiLaunchProfile } from '@happier-dev/protocol';

import {
    createDeferred,
    createExpoRouterMock,
    createReactNavigationNativeMock,
    createReactNativeWebMock,
    flushHookEffects,
    renderScreen,
    standardCleanup,
    type RenderScreenResult,
} from '@/dev/testkit';
import {
    createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createCapturingComponent, createPassThroughComponent } from '@/dev/testkit/mocks/components';
import { installProfilesCommonModuleMocks } from '@/components/profiles/profilesTestHelpers';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

type BeforeRemoveEvent = {
    data: { action: unknown };
    preventDefault: () => void;
};

type CapturedProfilesListProps = {
    onAddProfilePress?: () => void;
    onEditProfile?: (profile: AIBackendProfile) => void;
    machineId: string | null;
    serverId?: string | null;
    header?: React.ReactNode;
};

type CapturedEditFormProps = {
    profile: AiLaunchProfile;
    machineId: string | null;
    serverId?: string | null;
    onSave: (profile: AiLaunchProfile) => boolean;
    onCancel: () => void;
    onDirtyChange: (isDirty: boolean) => void;
    saveRef: React.MutableRefObject<(() => boolean) | null>;
    header?: React.ReactNode;
};

const promptUnsavedChangesAlertSpy = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({
    legacyBeforeRemove: null as null | ((event: BeforeRemoveEvent) => void),
    preventRemoveEnabled: false,
    preventRemoveCallback: null as null | ((event: { data: { action: unknown } }) => void),
    dispatch: vi.fn(),
}));
const settingsState = vi.hoisted(() => ({
    values: {
        useProfiles: true,
        profiles: [],
        lastUsedProfile: null,
        favoriteProfiles: [],
        profileEnabledById: {},
        providerSettingsV1: null,
        secretBindingsByProfileId: {},
    } as Record<string, unknown>,
}));
const administrationTargetState = vi.hoisted(() => ({
    selectedTarget: {
        serverIdentityId: 'server-identity-b',
        machineId: 'machine-b',
    } as { serverIdentityId: string; machineId: string } | null,
    executionTarget: {
        target: {
            serverIdentityId: 'server-identity-b',
            machineId: 'machine-b',
        },
        machine: { id: 'machine-b' },
        serverId: 'server-profile-b',
    } as {
        target: { serverIdentityId: string; machineId: string };
        machine: { id: string };
        serverId: string;
    } | null,
}));

const shareState = vi.hoisted(() => ({
    shown: [] as Array<{ chrome?: { testID?: string }; props?: Record<string, unknown> }>,
    alerts: [] as unknown[][],
    calls: [] as Array<{ actionId: string; input: unknown; context: unknown }>,
    publishResult: { ok: true, result: { artifactId: 'artifact-new' } } as unknown,
    savedFiles: [] as Array<{ fileName: string; json: string }>,
}));

installProfilesCommonModuleMocks({
    reactNative: () => createReactNativeWebMock({
        Platform: { OS: 'web' },
    }),
    // The modal host is the presentation boundary: the test reads what the page asked it to show.
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: {
            show: (config) => { shareState.shown.push(config as never); return 'modal-id'; },
            alert: (...args) => { shareState.alerts.push(args); },
        } }).module;
    },
    storage: () => createStorageModuleStub({
        useActiveServerAccountScope: () => ({ serverId: 'server-1', accountId: 'account-1' }),
        useAllMachines: () => [],
        useSetting: (key: string) => settingsState.values[key],
        useSettingMutable: (key: string) => [
            settingsState.values[key],
            vi.fn((value: unknown) => {
                settingsState.values[key] = value;
            }),
        ],
    }),
});

vi.mock('@react-navigation/native', () => createReactNavigationNativeMock({
    usePreventRemove: (enabled, callback) => {
        navigationState.preventRemoveEnabled = enabled;
        navigationState.preventRemoveCallback = callback;
    },
}));

const routerSpies = vi.hoisted(() => ({
    replace: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('expo-router', () => {
    const mock = createExpoRouterMock({
        navigation: {
            addListener: (event: string, callback: (event: BeforeRemoveEvent) => void) => {
                if (event === 'beforeRemove') {
                    navigationState.legacyBeforeRemove = callback;
                }
                return { remove: vi.fn() };
            },
            dispatch: navigationState.dispatch,
        },
    });
    routerSpies.replace = mock.spies.replace;
    return mock.module;
});

const applyProfileSaveSpy = vi.hoisted(() => vi.fn());
// The account settings writer is the persistence boundary (it syncs to the server).
vi.mock('@/sync/store/settingsWriters', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/store/settingsWriters')>()),
    useApplyProfileSave: () => applyProfileSaveSpy,
}));

// The Action front door is the boundary of publication: the Settings CAS and Artifact store are the host's.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>()),
    createFrontDoorActionExecute: () => async (actionId: string, input: unknown, context: unknown) => {
        shareState.calls.push({ actionId, input, context });
        return shareState.publishResult;
    },
}));

// The document file boundary (web download / native share sheet) is the platform edge of "Send a copy".
vi.mock('@/sync/domains/workflows/workflowDocumentFile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/workflows/workflowDocumentFile')>()),
    saveWorkflowDocument: async (file: { fileName: string; json: string }) => { shareState.savedFiles.push(file); },
}));

vi.mock('@/utils/ui/promptUnsavedChangesAlert', () => ({
    promptUnsavedChangesAlert: (...args: unknown[]) => promptUnsavedChangesAlertSpy(...args),
}));

vi.mock('@/components/secrets/useSavedSecretsMutable', () => ({
    useSavedSecretsMutable: () => [[], vi.fn()],
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => ({
        selectedTarget: administrationTargetState.selectedTarget,
        resolveExecutionTarget: () => administrationTargetState.executionTarget,
    }),
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: createPassThroughComponent('MachineAdministrationTargetSelector'),
}));

let capturedProfilesListProps: CapturedProfilesListProps | null = null;
vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: createCapturingComponent('ProfilesList', (props) => {
        capturedProfilesListProps = props as CapturedProfilesListProps;
    }),
}));

let capturedEditFormProps: CapturedEditFormProps | null = null;
vi.mock('@/components/profiles/edit', () => ({
    LaunchProfileEditForm: createCapturingComponent('LaunchProfileEditForm', (props) => {
        capturedEditFormProps = props as CapturedEditFormProps;
    }),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: createPassThroughComponent('ItemList'),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassThroughComponent('ItemGroup'),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassThroughComponent('Item'),
}));
vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: createPassThroughComponent('Switch'),
}));
vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: createPassThroughComponent('SecretRequirementModal'),
}));
vi.mock('@/components/profiles/migration/LegacyProfileMigrationFlow', () => ({
    LegacyProfileMigrationFlow: createPassThroughComponent('LegacyProfileMigrationFlow'),
}));
vi.mock('@/components/profiles/migration/LegacyProfileMigrationConflictFlow', () => ({
    LegacyProfileMigrationConflictFlow: createPassThroughComponent('LegacyProfileMigrationConflictFlow'),
}));

function currentBeforeRemoveCallback(): (event: BeforeRemoveEvent) => void {
    if (navigationState.preventRemoveEnabled && navigationState.preventRemoveCallback) {
        return navigationState.preventRemoveCallback;
    }
    if (navigationState.legacyBeforeRemove) {
        return navigationState.legacyBeforeRemove;
    }
    throw new Error('The profile detail did not register an unsaved-navigation guard');
}

const savedV2Profile = {
    v: 2 as const,
    id: 'profile-v2',
    name: 'Saved profile',
    extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {},
    defaultPersistenceModeByTargetKey: {},
    compatibilityByTargetKey: {},
    createdAt: 1,
    updatedAt: 1,
};

type DetailTarget =
    | { kind: 'profile'; profileId: string }
    | { kind: 'draft'; cloneFrom: string | null };

async function renderDetail(target: DetailTarget) {
    const { ProfileDetailScreen } = await import('@/components/settings/profiles/ProfileDetailScreen');
    return renderScreen(React.createElement(ProfileDetailScreen, { target }));
}

async function renderDirtyEditor(target: DetailTarget = { kind: 'profile', profileId: savedV2Profile.id }) {
    const screen = await renderDetail(target);
    expect(capturedEditFormProps).not.toBeNull();
    await act(async () => {
        capturedEditFormProps?.onDirtyChange(true);
    });
    return screen;
}

function hasEditor(screen: RenderScreenResult): boolean {
    return screen.findAll((node) => String(node.type) === 'LaunchProfileEditForm').length > 0;
}

function goBack(key: string) {
    return () => currentBeforeRemoveCallback()({
        data: { action: { type: 'GO_BACK', key } },
        preventDefault: vi.fn(),
    });
}

async function invokeAndFlush(callback: () => void): Promise<void> {
    await act(async () => {
        callback();
    });
    await flushHookEffects({ cycles: 4, turns: 4 });
}

describe('Settings › Profiles detail: machine scope and unsaved navigation', () => {
    beforeEach(async () => {
        // Profile readers resolve Settings rows for the focused Account only (U13 hydration).
        await seedFocusedAccount();
        capturedProfilesListProps = null;
        capturedEditFormProps = null;
        navigationState.legacyBeforeRemove = null;
        navigationState.preventRemoveEnabled = false;
        navigationState.preventRemoveCallback = null;
        navigationState.dispatch.mockReset();
        promptUnsavedChangesAlertSpy.mockReset();
        settingsState.values.useProfiles = true;
        settingsState.values.profiles = [savedV2Profile];
        applyProfileSaveSpy.mockReset();
        routerSpies.replace?.mockClear();
        administrationTargetState.selectedTarget = {
            serverIdentityId: 'server-identity-b',
            machineId: 'machine-b',
        };
        administrationTargetState.executionTarget = {
            target: {
                serverIdentityId: 'server-identity-b',
                machineId: 'machine-b',
            },
            machine: { id: 'machine-b' },
            serverId: 'server-profile-b',
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('uses the exact Administration target for V2 profile reads instead of an active or first machine', async () => {
        await renderDirtyEditor();

        expect(capturedEditFormProps).toMatchObject({
            machineId: 'machine-b',
            serverId: 'server-profile-b',
        });
        const header = capturedEditFormProps?.header;
        expect(React.isValidElement(header)).toBe(true);
        if (!React.isValidElement(header)) throw new Error('Expected the profile header');
        // The machine chip rides on the header of a machine-scoped (V2) profile.
        expect(header.props).toMatchObject({ showMachineChip: true });
    });

    it('does not substitute another machine when the selected Administration target is no longer executable', async () => {
        administrationTargetState.executionTarget = null;

        await renderDirtyEditor();

        expect(capturedEditFormProps).toMatchObject({
            machineId: null,
            serverId: null,
        });
    });

    it('keeps legacy profile preview selection explicit', async () => {
        const { DEFAULT_PROFILES } = await import('@/sync/domains/profiles/profileUtils');
        const builtInDefinition = DEFAULT_PROFILES[0];
        if (!builtInDefinition) throw new Error('Expected a legacy profile fixture');

        await renderDetail({ kind: 'profile', profileId: builtInDefinition.id });

        expect(capturedEditFormProps?.profile).toMatchObject({ id: builtInDefinition.id });
        expect(capturedEditFormProps).toMatchObject({
            machineId: null,
            serverId: null,
        });
        expect(React.isValidElement(capturedEditFormProps?.header)
            && (capturedEditFormProps?.header as React.ReactElement<{ showMachineChip: boolean }>).props.showMachineChip).toBe(false);
    });

    it('serializes repeated navigator exits while the first decision is pending', async () => {
        const decision = createDeferred<UnsavedChangesDecision>();
        promptUnsavedChangesAlertSpy.mockReturnValue(decision.promise);
        await renderDirtyEditor();
        const beforeRemove = currentBeforeRemoveCallback();

        await act(async () => {
            beforeRemove({
                data: { action: { type: 'GO_BACK', key: 'first' } },
                preventDefault: vi.fn(),
            });
            beforeRemove({
                data: { action: { type: 'GO_BACK', key: 'second' } },
                preventDefault: vi.fn(),
            });
            await Promise.resolve();
        });

        await act(async () => {
            decision.resolve('keepEditing');
            await decision.promise;
            await Promise.resolve();
        });

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledOnce();
        expect(navigationState.dispatch).not.toHaveBeenCalled();
        expect(capturedEditFormProps).not.toBeNull();
    });

    it('keeps the dirty editor on Keep editing and continues the exit on Discard', async () => {
        promptUnsavedChangesAlertSpy
            .mockResolvedValueOnce('keepEditing')
            .mockResolvedValueOnce('discard');
        const screen = await renderDirtyEditor();

        await invokeAndFlush(goBack('keep'));

        expect(hasEditor(screen)).toBe(true);
        expect(navigationState.dispatch).not.toHaveBeenCalled();

        await invokeAndFlush(goBack('discard'));

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledTimes(2);
        expect(navigationState.dispatch).toHaveBeenCalledOnce();
        expect(navigationState.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK', key: 'discard' });
    });

    it('keeps the dirty editor and navigation blocked on save failure, then continues after save succeeds', async () => {
        promptUnsavedChangesAlertSpy.mockResolvedValue('save');
        const screen = await renderDirtyEditor();
        const firstEditForm = capturedEditFormProps;
        if (!firstEditForm) throw new Error('Expected the profile editor');
        firstEditForm.saveRef.current = () => false;

        await invokeAndFlush(goBack('save-fails'));

        expect(hasEditor(screen)).toBe(true);
        expect(navigationState.dispatch).not.toHaveBeenCalled();

        const currentEditForm = capturedEditFormProps;
        if (!currentEditForm) throw new Error('Expected the profile editor after save failure');
        currentEditForm.saveRef.current = () => currentEditForm.onSave({
            ...currentEditForm.profile,
            name: 'Renamed profile',
        });

        await invokeAndFlush(goBack('save-succeeds'));

        expect(applyProfileSaveSpy).toHaveBeenCalledWith(expect.objectContaining({ profileId: savedV2Profile.id }));
        expect(navigationState.dispatch).toHaveBeenCalledOnce();
        expect(navigationState.dispatch).toHaveBeenCalledWith({
            type: 'GO_BACK',
            key: 'save-succeeds',
        });
    });

    it('selects a saved draft in the collection, but lets a save on the way out keep the exit', async () => {
        await renderDetail({ kind: 'draft', cloneFrom: null });
        const draftForm = capturedEditFormProps;
        if (!draftForm) throw new Error('Expected the draft editor');

        let saved = false;
        await act(async () => {
            saved = draftForm.onSave({ ...draftForm.profile, name: 'Fresh profile' });
        });

        expect(saved).toBe(true);
        expect(applyProfileSaveSpy).toHaveBeenCalledWith(expect.objectContaining({ profileId: draftForm.profile.id }));
        expect(routerSpies.replace).toHaveBeenCalledWith(`/settings/profiles/${encodeURIComponent(draftForm.profile.id)}`);

        routerSpies.replace.mockClear();
        promptUnsavedChangesAlertSpy.mockResolvedValue('save');
        await renderDirtyEditor({ kind: 'draft', cloneFrom: null });
        const exitingForm = capturedEditFormProps;
        if (!exitingForm) throw new Error('Expected the second draft editor');
        exitingForm.saveRef.current = () => exitingForm.onSave({ ...exitingForm.profile, name: 'Saved on exit' });

        await invokeAndFlush(goBack('save-on-exit'));

        expect(routerSpies.replace).not.toHaveBeenCalled();
        expect(navigationState.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK', key: 'save-on-exit' });
    });

    it('keeps built-in Save As prompt semantics', async () => {
        const { DEFAULT_PROFILES } = await import('@/sync/domains/profiles/profileUtils');
        const builtInDefinition = DEFAULT_PROFILES[0];
        if (!builtInDefinition) throw new Error('Expected at least one built-in Profile fixture');
        promptUnsavedChangesAlertSpy.mockResolvedValue('keepEditing');

        await renderDirtyEditor({ kind: 'profile', profileId: builtInDefinition.id });
        await invokeAndFlush(goBack('built-in'));

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                saveText: 'common.saveAs',
                message: expect.stringContaining('profiles.builtInSaveAsHint'),
            }),
        );
    });

    it('uses the shared browser-unload guard only while the editor is dirty', async () => {
        const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
        type BeforeUnloadHandler = (event: {
            preventDefault: () => void;
            returnValue?: string;
        }) => void;
        const beforeUnloadHandlerRef: { current: BeforeUnloadHandler | null } = { current: null };
        const addEventListener = vi.fn((type: string, handler: BeforeUnloadHandler) => {
            if (type === 'beforeunload') beforeUnloadHandlerRef.current = handler;
        });
        const removeEventListener = vi.fn((type: string, handler: BeforeUnloadHandler) => {
            if (type === 'beforeunload' && beforeUnloadHandlerRef.current === handler) {
                beforeUnloadHandlerRef.current = null;
            }
        });
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { addEventListener, removeEventListener },
        });

        try {
            await renderDirtyEditor();

            expect(addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
            const preventDefault = vi.fn();
            const event = { preventDefault, returnValue: undefined as string | undefined };
            beforeUnloadHandlerRef.current?.(event);
            expect(preventDefault).toHaveBeenCalledOnce();
            expect(event.returnValue).toBe('');

            await act(async () => {
                capturedEditFormProps?.onDirtyChange(false);
            });

            expect(removeEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
            expect(beforeUnloadHandlerRef.current).toBeNull();
        } finally {
            if (originalWindowDescriptor) {
                Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'window');
            }
        }
    });
});

const publishedProfileContent = {
    kind: 'launch-profile.v1' as const,
    profile: { ...savedV2Profile, id: 'team-v2', name: 'Team profile' },
    secretBindings: {},
};

async function seedFocusedAccount(artifacts: Record<string, unknown> = {}) {
    // The real store: profile readers hydrate references from its Artifact documents for the focused Account.
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.setState({ settingsScope: { serverId: 'server-1', accountId: 'account-1' }, artifacts } as never);
}

function headerMenuActions(): Array<{ id: string; onSelect: () => unknown }> {
    const header = capturedEditFormProps?.header;
    if (!React.isValidElement(header)) throw new Error('Expected the profile header');
    return (header.props as { menuActions: Array<{ id: string; onSelect: () => unknown }> }).menuActions;
}

describe('Settings › Profiles detail: Share…', () => {
    beforeEach(async () => {
        capturedEditFormProps = null;
        shareState.shown = [];
        shareState.alerts = [];
        shareState.calls = [];
        shareState.savedFiles = [];
        shareState.publishResult = { ok: true, result: { artifactId: 'artifact-new' } };
        promptUnsavedChangesAlertSpy.mockReset();
        settingsState.values.profiles = [savedV2Profile];
        await seedFocusedAccount();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('opens the one document share sheet on a published profile without publishing it again', async () => {
        settingsState.values.profiles = [{ artifactId: 'artifact-team' }];
        await seedFocusedAccount({
            'artifact-team': {
                id: 'artifact-team', isDecrypted: true, title: 'Team profile',
                header: { kind: 'launch-profile.v1', profileId: 'team-v2', name: 'Team profile', title: 'Team profile' },
                body: JSON.stringify(publishedProfileContent),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            },
        });
        await renderDetail({ kind: 'profile', profileId: 'team-v2' });
        const share = headerMenuActions().find((action) => action.id === 'share');
        expect(share).toBeDefined();
        await act(async () => { await share!.onSelect(); });

        expect(shareState.calls).toEqual([]);
        expect(shareState.shown).toHaveLength(1);
        expect(shareState.shown[0]).toMatchObject({
            chrome: { testID: 'document-share-modal' },
            props: { kind: 'launch-profile.v1', artifactId: 'artifact-team', linkPath: '/settings/profiles/team-v2' },
        });

        // "Send a copy instead" hands over the value-free document itself, never Settings values.
        await act(async () => { await (shareState.shown[0]!.props!.onSendCopy as () => unknown)(); });
        await vi.waitFor(() => expect(shareState.savedFiles).toHaveLength(1));
        const { LaunchProfileArtifactV1Schema } = await import('@happier-dev/protocol');
        expect(LaunchProfileArtifactV1Schema.parse(JSON.parse(shareState.savedFiles[0]!.json)))
            .toEqual(LaunchProfileArtifactV1Schema.parse(publishedProfileContent));
    });

    it('publishes a saved inline profile once, as the person on this Home, then shares the new Artifact', async () => {
        await renderDetail({ kind: 'profile', profileId: savedV2Profile.id });
        await act(async () => { await headerMenuActions().find((action) => action.id === 'share')!.onSelect(); });

        expect(shareState.calls).toEqual([{
            actionId: 'launch_profiles.publish',
            input: { profileId: savedV2Profile.id },
            context: expect.objectContaining({ surface: 'ui', authority: 'present_user', serverId: 'server-1' }),
        }]);
        expect(shareState.shown[0]).toMatchObject({
            chrome: { testID: 'document-share-modal' },
            props: { kind: 'launch-profile.v1', artifactId: 'artifact-new' },
        });
    });

    it('explains a secret-value refusal and opens no sheet', async () => {
        shareState.publishResult = { ok: false, errorCode: 'action_failed', error: 'profile_contains_secret_values' };
        await renderDetail({ kind: 'profile', profileId: savedV2Profile.id });
        await act(async () => { await headerMenuActions().find((action) => action.id === 'share')!.onSelect(); });

        expect(shareState.shown).toEqual([]);
        expect(shareState.alerts).toEqual([[
            'roles.profiles.shareFailedTitle',
            'roles.profiles.shareNeedsSavedSecrets',
        ]]);
    });

    it('does not publish over unsaved edits the person chose to keep editing', async () => {
        promptUnsavedChangesAlertSpy.mockResolvedValue('keepEditing');
        await renderDirtyEditor();
        await act(async () => { await headerMenuActions().find((action) => action.id === 'share')!.onSelect(); });

        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalledOnce();
        expect(shareState.calls).toEqual([]);
        expect(shareState.shown).toEqual([]);
    });

    it('offers no Share on a built-in profile or a draft', async () => {
        const { DEFAULT_PROFILES } = await import('@/sync/domains/profiles/profileUtils');
        await renderDetail({ kind: 'profile', profileId: DEFAULT_PROFILES[0]!.id });
        expect(headerMenuActions().map((action) => action.id)).not.toContain('share');
        await renderDetail({ kind: 'draft', cloneFrom: null });
        expect(headerMenuActions().map((action) => action.id)).not.toContain('share');
    });
});
