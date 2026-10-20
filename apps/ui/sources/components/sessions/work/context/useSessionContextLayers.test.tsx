import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { getBuiltInBackendProfile } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook, standardCleanup } from '@/dev/testkit';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
const { saveAuthoringMemoryProjection } = await import('@/sync/domains/state/authoringMemoryPersistence');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { applyProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } = await import('@/sync/store/settings/profileCatalogSnapshot');
const { resetProfileCatalogEngineForTests } = await import('@/sync/engine/settings/profileCatalogEngine');
const { useHomeAiLaunchProfileCatalog } = await import('@/sync/store/useAiLaunchProfiles');
const { storage } = await import('@/sync/domains/state/storage');
const { useSessionContextLayers } = await import('./useSessionContextLayers');

const ready: ProfileCatalogSnapshotV1 = {
    status: 'ready', authority: 'inactive', source: 'destination', control: null,
    controlRevision: 'absent', records: [], diagnostics: [], referenceGuardRevision: 'absent',
};
let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => {
    standardCleanup();
    resetProfileCatalogEngineForTests();
    resetProfileCatalogSnapshotsForTests();
    await fixture?.dispose();
    fixture = undefined;
});

describe('Work admitted Profile context', () => {
    it('keeps an own disabled Plan re-enableable while inherited source-disabled context stays locked', async () => {
        fixture = await createPlainArtifactHomeFixture('https://work-context-plan.example');
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, settingsDefaults, 1);
        applyProfileCatalogSnapshot(scope, { ...ready, records: [{ revision: 1, record: {
            v: 1, id: 'azure-openai', definition: { kind: 'legacy', profile: AIBackendProfileSchema.parse(getBuiltInBackendProfile('azure-openai')) },
            enabled: true, promptStack: [{ id: 'profile-plan', ref: { kind: 'doc', artifactId: 'plan-doc' },
                enabled: false, placement: 'system_append' }], skillSeeds: [], secretBindings: {},
        } }] }, true);
        storage.getState().applyArtifacts([{ id: 'plan-doc', title: 'Plan',
            header: { v: 1, kind: 'prompt_doc.v2', title: 'Plan' },
            ownerAccountId: scope.accountId, access: 'owner', isDecrypted: true, body: null,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]);
        const hook = await renderHook((enabled: boolean) => useSessionContextLayers({ serverId: scope.serverId,
            sessionId: 'work', ownerMetadata: { profileId: 'azure-openai', work: { promptStack: [{ id: 'plan', plan: true,
                ref: { kind: 'doc', artifactId: 'plan-doc' }, enabled, placement: 'system_append' }] } }, metadataVersion: 1 }), { initialProps: false });
        expect(hook.getCurrent().sessionStackValid).toBe(true);
        expect(hook.getCurrent().session[0]?.entry.plan).toBe(true);
        expect(hook.getCurrent().session[0]).toMatchObject({ off: 'session', on: false });
        expect(hook.getCurrent().profile.rows[0]).toMatchObject({ off: 'source', on: false });
        await hook.rerender(true);
        expect(hook.getCurrent().session[0]).toMatchObject({ off: null, on: true });
        expect(hook.getCurrent().profile.rows[0]).toMatchObject({ off: 'source', on: false });
    });
    it('projects only prompt-preparation placements while preserving a historical generic bundle', async () => {
        fixture = await createPlainArtifactHomeFixture('https://work-context-placements.example');
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, settingsDefaults, 1);
        const entries = ['system_append', 'skill_instructions', 'provider_asset', 'composer_insert'].map(placement => ({
            id: placement, ref: { kind: 'bundle', artifactId: 'generic' }, enabled: true, placement,
        }));
        storage.getState().applyArtifacts([{ id: 'generic', title: 'Retained bundle',
            header: { v: 1, kind: 'prompt_bundle.v2', title: 'Retained bundle', bundleSchemaId: 'bundle.generic_v1' },
            ownerAccountId: scope.accountId, access: 'owner', isDecrypted: true, body: null,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]);
        const hook = await renderHook(() => useSessionContextLayers({ serverId: scope.serverId,
            sessionId: 'work', ownerMetadata: { work: { promptStack: entries } }, metadataVersion: 1 }));
        expect(hook.getCurrent().sessionStackValid).toBe(true);
        expect(hook.getCurrent().session.map(row => row.entry.id)).toEqual(['system_append', 'skill_instructions']);
    });
    it('admits legitimate rowless built-ins while refusing unknown, disabled and incomplete selections', async () => {
        fixture = await createPlainArtifactHomeFixture('https://work-profile-admission.example');
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        storage.getState().applySettingsForScope(scope, { ...settingsDefaults, favoriteProfiles: ['azure-openai'] }, 1);
        applyProfileCatalogSnapshot(scope, ready, true);
        const hook = await renderHook((profileId: string) => useSessionContextLayers({
            serverId: scope.serverId, sessionId: 'work', ownerMetadata: { profileId }, metadataVersion: 1,
        }), { initialProps: 'azure-openai' });
        expect(hook.getCurrent().profile).toMatchObject({ status: 'ready', name: 'Azure OpenAI', rows: [] });
        await hook.rerender('unknown-profile');
        expect(hook.getCurrent().profile.status).toBe('unavailable');
        await hook.rerender('azure-openai');
        await React.act(async () => {
            storage.getState().applySettingsForScope(scope, { ...settingsDefaults, favoriteProfiles: ['azure-openai'],
                profileEnabledById: { 'azure-openai': false } }, 2);
        });
        expect(hook.getCurrent().profile.status).toBe('unavailable');
        await React.act(async () => {
            storage.getState().applySettingsForScope(scope, { ...settingsDefaults, profileEnabledById: { 'azure-openai': true } }, 3);
        });
        expect(hook.getCurrent().profile.status).toBe('ready');
        await React.act(async () => {
            if (ready.status !== 'ready') throw new Error('Expected ready fixture');
            applyProfileCatalogSnapshot(scope, { ...ready, status: 'partial', diagnostics: [{ id: 'opaque', revision: 1,
                reason: 'invalid-stored-content' }] }, true);
        });
        expect(hook.getCurrent().profile.status).toBe('unavailable');
    });

    it('uses the addressed Home evidence and lets a real disabled row shadow its retained builtin', async () => {
        fixture = await createPlainArtifactHomeFixture('https://work-profile-addressed.example');
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        const addressed = { serverId: 'profile-other-home', accountId: 'profile-other-account' };
        storage.getState().applySettingsForScope(scope, { ...settingsDefaults, favoriteProfiles: ['azure-openai'],
            profileEnabledById: { 'gemini-api-key': false } }, 1);
        saveAccountSettings(addressed, { ...settingsDefaults, profileEnabledById: { 'gemini-api-key': true } }, 1);
        saveAuthoringMemoryProjection(addressed, { lastUsedProfile: 'azure-openai', recentMachinePaths: [], lastEngineSelectionsByScopeV1: {} });
        applyProfileCatalogSnapshot(addressed, ready, true);
        const hook = await renderHook(() => ({
            remembered: useHomeAiLaunchProfileCatalog(addressed, 'azure-openai'),
            enabled: useHomeAiLaunchProfileCatalog(addressed, 'gemini-api-key'),
        }));
        expect(hook.getCurrent().remembered.selectedProfile).toMatchObject({ id: 'azure-openai' });
        expect(hook.getCurrent().enabled.selectedProfile).toMatchObject({ id: 'gemini-api-key' });
        expect(hook.getCurrent().remembered.profiles).toEqual([]);
        await React.act(async () => {
            if (ready.status !== 'ready') throw new Error('Expected ready fixture');
            applyProfileCatalogSnapshot(addressed, { ...ready, records: [{ revision: 1, record: {
                v: 1, id: 'azure-openai', definition: { kind: 'legacy', profile: AIBackendProfileSchema.parse(getBuiltInBackendProfile('azure-openai')) },
                enabled: false, promptStack: [], skillSeeds: [], secretBindings: {},
            } }] }, true);
        });
        expect(hook.getCurrent().remembered.selectedProfile).toBeNull();
        expect(hook.getCurrent().remembered.profiles).toMatchObject([{ id: 'azure-openai', enabled: false }]);
    });
});
