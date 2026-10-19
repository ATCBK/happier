import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { applyPromptLibraryCatalogSnapshot, beginPromptLibraryCatalogLoad, resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { applyProfileCatalogSnapshot, beginProfileCatalogLoad, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { resetProfileCatalogEngineForTests } from '@/sync/engine/settings/profileCatalogEngine';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { buildLaunchProfileArtifactHeaderV1, LaunchProfileArtifactV1Schema } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { t } from '@/text';
import { PromptStackEditorScreen } from './PromptStackEditorScreen';
import { PromptProfileStacksScreen } from './PromptProfileStacksScreen';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', ScrollView: 'ScrollView', Switch: 'Switch' });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const scope = { serverId: 'stack-readiness-home', accountId: 'stack-readiness-account' };
describe('Prompt stack authoritative readiness', () => {
    beforeEach(() => {
        resetPromptLibraryCatalogEngineForTests();
        resetPromptLibraryCatalogSnapshotsForTests();
        resetProfileCatalogEngineForTests();
        resetProfileCatalogSnapshotsForTests();
        storage.setState({ settings: settingsDefaults, settingsVersion: 7, settingsScope: scope,
            profileScope: scope, isDataReady: true, artifactsLoaded: true, artifacts: {} });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://stack-readiness.invalid', generation: 1 });
    });

    it('distinguishes an unknown or missing Profile from a loaded empty Profile stack', async () => {
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <PromptStackEditorScreen surface="profile" profileId="profile-1" title="Profile Context" />
        </InjectedAuthProvider>);
        expect(screen.findByTestId('promptStack.empty')).toBeNull();
        expect(screen.findByTestId('promptStack.readState-loading-spinner')).not.toBeNull();
        const ready = { status: 'ready' as const, authority: 'inactive' as const, source: 'destination' as const,
            control: null, controlRevision: 'absent' as const, records: [], diagnostics: [], referenceGuardRevision: 1 };
        await act(async () => { applyProfileCatalogSnapshot(scope, ready, true); });
        expect(screen.findByTestId('promptStack.empty')).toBeNull();
        expect(screen.findByTestId('promptStack.readState')).not.toBeNull();
        const profile = AIBackendProfileSchema.parse({ id: 'profile-1', name: 'Profile', environmentVariables: [], createdAt: 1, updatedAt: 1 });
        await act(async () => {
            applyProfileCatalogSnapshot(scope, { ...ready, records: [{ revision: 3,
                record: { v: 1, id: profile.id, definition: { kind: 'legacy', profile },
                    enabled: true, promptStack: [], skillSeeds: [], secretBindings: {} } }] }, true);
        });
        expect(screen.findByTestId('promptStack.empty')).not.toBeNull();
        expect(screen.findByTestId('promptStack.readState')).toBeNull();
        await act(async () => { beginProfileCatalogLoad(scope); });
        expect(screen.findByTestId('promptStack.empty')).not.toBeNull();
        expect(screen.findByTestId('promptStack.freshness')).toBeNull();
        await act(async () => { applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true); });
        expect(screen.findByTestId('promptStack.empty')).toBeNull();
        expect(screen.findByTestId('promptStack.readState')).not.toBeNull();
    });

    it('does not infer an empty private Context from a shared definition until private membership absence is known', async () => {
        const profile = AIBackendProfileSchema.parse({ id: 'granted-profile', name: 'Shared Profile', environmentVariables: [], createdAt: 1, updatedAt: 1 });
        const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1', profile, secretBindings: {} });
        const resource = { artifactId: 'shared-profile-artifact', header: buildLaunchProfileArtifactHeaderV1(content),
            body: JSON.stringify(content), access: 'view', ownerAccountId: 'other-account',
            revision: { headerVersion: 2, bodyVersion: 3 } } satisfies ArtifactSharingResourceV1;
        const artifacts = new Map([[resource.artifactId, resource]]);
        const inventory = { authority: 'inactive' as const, source: 'destination' as const,
            control: null, controlRevision: 'absent' as const, records: [], referenceGuardRevision: 1 };
        applyProfileCatalogSnapshot(scope, { ...inventory, status: 'partial',
            diagnostics: [{ id: profile.id, revision: 3, reason: 'invalid-stored-content' }] }, true, artifacts);
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <PromptStackEditorScreen surface="profile" profileId={profile.id} title="Profile Context" />
        </InjectedAuthProvider>);
        expect(screen.findByTestId('promptStack.empty')).toBeNull();
        expect(screen.findByTestId('promptStack.readState')).not.toBeNull();
        await act(async () => { beginProfileCatalogLoad(scope); });
        expect(screen.findByTestId('promptStack.empty')).toBeNull();
        await act(async () => {
            applyProfileCatalogSnapshot(scope, { ...inventory, status: 'ready', diagnostics: [] }, true, artifacts);
        });
        expect(screen.findByTestId('promptStack.empty')).not.toBeNull();
        await act(async () => { beginProfileCatalogLoad(scope); });
        expect(screen.findByTestId('promptStack.empty')).not.toBeNull();
        expect(screen.findByTestId('promptStack.freshness')).toBeNull();
        await act(async () => {
            applyProfileCatalogSnapshot(scope, { ...inventory, status: 'partial', records: [{ revision: 4,
                record: { v: 1, id: profile.id, definition: { kind: 'artifact', artifactId: resource.artifactId },
                    enabled: true, promptStack: [], skillSeeds: [], secretBindings: {} } }],
                diagnostics: [{ id: 'unreadable-neighbor', revision: 2, reason: 'invalid-stored-content' }] }, true, artifacts);
        });
        // An addressed readable private row stays known, even if a different row is unreadable.
        expect(screen.findByTestId('promptStack.empty')).not.toBeNull();
        expect(screen.findByTestId('promptStack.readState')).toBeNull();
        expect(screen.findByTestId('promptStack.freshness')).not.toBeNull();
    });

    it('keeps a reachable shared Profile in the index without claiming its unread private Context has zero items', async () => {
        const profile = AIBackendProfileSchema.parse({ id: 'granted-profile', name: 'Shared Profile', environmentVariables: [], createdAt: 1, updatedAt: 1 });
        const content = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1', profile, secretBindings: {} });
        const resource = { artifactId: 'shared-profile-artifact', header: buildLaunchProfileArtifactHeaderV1(content),
            body: JSON.stringify(content), access: 'view', ownerAccountId: 'other-account',
            revision: { headerVersion: 2, bodyVersion: 3 } } satisfies ArtifactSharingResourceV1;
        const inventory = { authority: 'inactive' as const, source: 'destination' as const,
            control: null, controlRevision: 'absent' as const, records: [], referenceGuardRevision: 1 };
        const artifacts = new Map([[resource.artifactId, resource]]);
        applyProfileCatalogSnapshot(scope, { ...inventory, status: 'partial',
            diagnostics: [{ id: profile.id, revision: 3, reason: 'invalid-stored-content' }] }, true, artifacts);
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <PromptProfileStacksScreen />
        </InjectedAuthProvider>);
        expect(screen.findHostByTestId(`promptStacks.profile.${profile.id}`)).not.toBeNull();
        expect(screen.getTextContent()).toContain(profile.name);
        expect(screen.getTextContent()).not.toContain(t('promptLibrary.profileStackCount', { count: 0 }));
        await screen.pressByTestIdAsync(`promptStacks.profile.${profile.id}`);
        await act(async () => {
            applyProfileCatalogSnapshot(scope, { ...inventory, status: 'ready', diagnostics: [] }, true, artifacts);
        });
        expect(screen.getTextContent()).toContain(t('promptLibrary.profileStackCount', { count: 0 }));
        await act(async () => { beginProfileCatalogLoad(scope); });
        expect(screen.getTextContent()).toContain(t('promptLibrary.profileStackCount', { count: 0 }));
    });

    it('does not turn an unread Profile index into an empty one and retains known-empty inventory while refreshing', async () => {
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <PromptProfileStacksScreen />
        </InjectedAuthProvider>);
        expect(screen.findByTestId('promptStacks.profiles.empty')).toBeNull();
        expect(screen.findByTestId('promptStacks.profiles.readState-loading-spinner')).not.toBeNull();
        const inventory = { authority: 'inactive' as const, source: 'destination' as const,
            control: null, controlRevision: 'absent' as const, records: [], referenceGuardRevision: 1 };
        await act(async () => {
            applyProfileCatalogSnapshot(scope, { ...inventory, status: 'partial',
                diagnostics: [{ id: 'unreadable-profile', revision: 3, reason: 'invalid-stored-content' }] }, true);
        });
        expect(screen.findByTestId('promptStacks.profiles.empty')).toBeNull();
        expect(screen.findByTestId('promptStacks.profiles.readState')).not.toBeNull();
        await act(async () => { applyProfileCatalogSnapshot(scope, { ...inventory, status: 'ready', diagnostics: [] }, true); });
        expect(screen.findByTestId('promptStacks.profiles.empty')).not.toBeNull();
        expect(screen.findByTestId('promptStacks.profiles.readState')).toBeNull();
        await act(async () => { beginProfileCatalogLoad(scope); });
        expect(screen.findByTestId('promptStacks.profiles.empty')).not.toBeNull();
        expect(screen.findByTestId('promptStacks.profiles.freshness')).not.toBeNull();
        await act(async () => { applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true); });
        expect(screen.findByTestId('promptStacks.profiles.empty')).toBeNull();
        expect(screen.findByTestId('promptStacks.profiles.readState')).not.toBeNull();
    });

    it.each(['coding', 'voice'] as const)('does not turn an unknown %s stack into an empty one, but admits a genuinely empty ready stack', async (surface) => {
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <PromptStackEditorScreen surface={surface} title="Context" />
        </InjectedAuthProvider>);
        expect(screen.findByTestId('promptStack.empty')).toBeNull();
        expect(screen.findByTestId('promptStack.readState-loading-spinner')).not.toBeNull();

        await act(async () => {
            applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 4,
                record: { key: surface, value: { v: 1, scope: { kind: surface }, entries: [] } } }],
                tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        });
        expect(screen.findByTestId('promptStack.empty')).not.toBeNull();
        expect(screen.findByTestId('promptStack.readState-loading-spinner')).toBeNull();

        await act(async () => { beginPromptLibraryCatalogLoad(scope); });
        expect(screen.findByTestId('promptStack.empty')).not.toBeNull();
        expect(screen.findByTestId('promptStack.freshness')).toBeNull();
        await act(async () => {
            applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'unavailable', reason: 'forbidden' },
                rawSettings: {}, sourceSettingsVersion: 7 }, true);
        });
        expect(screen.findByTestId('promptStack.empty')).toBeNull();
        expect(screen.findByTestId('promptStack.readState')).not.toBeNull();
    });
});
