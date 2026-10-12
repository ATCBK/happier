import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import type { StorageState } from '@/sync/store/types';

import { activateStorageAccountScope, createLiveStorageStoreMock, createStorageModuleMock, createStorageModuleStub, createStorageStoreModuleMock, createStorageStoreMock, createUseSettingMock } from './storage';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { createSessionFixture } from '../fixtures/sessionFixtures';
import { createToolCallMessageFixture } from '../fixtures/transcriptFixtures';
import { clearSessionMessageDerivedCachesForServerScopeReset, readSessionMessagesSnapshot } from '@/sync/store/hooks';
import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';

describe('storage fixture setting readers', () => {
    it('keeps the real Account lifetime stable until the fixture Home retires', async () => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { readRegisteredStorageState } = await import('@/sync/domains/state/storageStateReaderBridge');
        const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousSnapshot = runtime.getAppliedActiveServerSnapshot();
        const previousAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
        const canonicalScope = getStorage().getState().profileScope;
        const fixtureStorage = create<StorageState>(() => createStorageStoreMock({}).getState());
        const home = await activateStorageAccountScope({ serverId: 'fixture-home', accountId: 'fixture-account' }, fixtureStorage);
        try {
            const lifetime = captureActiveServerAccountScopeLifetime();
            expect(lifetime?.scope).toEqual({ serverId: 'fixture-home', accountId: 'fixture-account' });
            expect(captureActiveServerAccountScopeLifetime()).toBe(lifetime);
            expect(createStorageModuleStub({}).useActiveServerAccountScopeLifetime()).toBe(lifetime);
            expect(createStorageModuleStub({}).useActiveServerAccountScope()).toBe(lifetime?.scope);
            expect(lifetime?.isCurrent()).toBe(true);
            home.dispose();
            expect(lifetime?.isCurrent()).toBe(false);
            expect(fixtureStorage.getState().profileScope).toBeUndefined();
            expect(readRegisteredStorageState()).toBe(getStorage().getState());
            expect(getStorage().getState().profileScope).toBe(canonicalScope);
            expect(runtime.getAppliedActiveServerSnapshot()).toEqual(previousSnapshot);
            expect(runtime.isAppliedActiveServerRuntimeAvailable()).toBe(previousAvailable);
        } finally {
            home.dispose();
        }
        expect(createStorageModuleStub({}).useActiveServerAccountScopeLifetime()).toBeNull();
    });

    it('supports unhydrated organization reads and preserves injected Home-qualified pin records', () => {
        const sessionId = 'shared-session';
        const homeAKey = buildSessionOrganizationSessionKey('home-a', sessionId);
        const homeBKey = buildSessionOrganizationSessionKey('home-b', sessionId);
        const readRailPinned = (store: ReturnType<typeof createStorageStoreMock>, key: string) =>
            store((state) => state.sessionOrganizationPinsBySessionKey[key]?.railPinned === true);
        const emptyStore = createStorageStoreMock({});
        expect(readRailPinned(emptyStore, homeAKey)).toBe(false);

        const pins = {
            [homeBKey]: { sessionId, sortKey: null, pinnedAt: 1, listPinned: false, railPinned: true },
        };
        const store = createStorageStoreMock({ sessionOrganizationPinsBySessionKey: pins });
        expect(store.getState().sessionOrganizationPinsBySessionKey).toBe(pins);
        expect(readRailPinned(store, homeAKey)).toBe(false);
        expect(readRailPinned(store, homeBKey)).toBe(true);
    });

    it('reads the injected Session owner and keeps the canonical ordered transcript snapshot', () => {
        const session = createSessionFixture();
        let sessions = { [session.id]: session };
        const store = createLiveStorageStoreMock(() => ({ sessions }));
        const module = createStorageModuleStub({ storage: store });
        expect(store((state) => [state.profile.connectedServicesV2, state.profile.connectedAccountsV4])).toEqual([[], []]);
        expect(store((state) => state.profile)).toBe(module.useProfile());
        const explicitProfile = { ...store.getState().profile, id: 'account-2' };
        const overriddenStore = createLiveStorageStoreMock(() => ({ profile: explicitProfile }));
        expect(overriddenStore((state) => state.profile)).toBe(explicitProfile);
        expect(module.useSessionMachineId(session.id)).toBe('machine-1');
        expect(module.useSessionMachineId('absent')).toBeNull();
        sessions = { [session.id]: { ...session, metadata: { ...session.metadata!, machineId: 'machine-2' } } };
        expect(module.useSessionMachineId(session.id)).toBe('machine-2');

        const first = createToolCallMessageFixture({ id: 'first', createdAt: 1 });
        const second = createToolCallMessageFixture({ id: 'second', createdAt: 2 });
        const snapshot = module.readSessionMessagesSnapshot(session.id, ['second', 'first'], { first, second }, 1, true);
        expect(snapshot).toEqual([second, first]);
        expect(module.readSessionMessagesSnapshot(session.id, [], {}, 2, false)).toBe(snapshot);
        expect(readSessionMessagesSnapshot(session.id, [], {}, 2, false)).toBe(snapshot);
        clearSessionTranscriptDerivedCachesForSession(session.id);
        expect(module.readSessionMessagesSnapshot(session.id, [], {}, 2, false)).toEqual([]);
        module.readSessionMessagesSnapshot(session.id, ['first'], { first }, 3, true);
        clearSessionMessageDerivedCachesForServerScopeReset();
        expect(module.readSessionMessagesSnapshot(session.id, [], {}, 4, false)).toEqual([]);
    });

    it('reads the injected setting through both read-only and mutable hooks as the fixture changes', () => {
        const values: { scmGitPaneLayout: 'tabs' | 'unified' } = { scmGitPaneLayout: 'tabs' };
        const module = createStorageModuleStub({ useSetting: createUseSettingMock({ values }) });

        expect(module.useSetting('scmGitPaneLayout')).toBe('tabs');
        expect(module.useSettingMutable('scmGitPaneLayout')[0]).toBe('tabs');
        values.scmGitPaneLayout = 'unified';
        expect(module.useSettingMutable('scmGitPaneLayout')[0]).toBe('unified');
    });

    it('uses the injected reader for a partial module without replacing an explicit mutable fixture', async () => {
        const original = createStorageModuleStub({});
        // Module-loader boundary: return a deterministic original namespace, not an app singleton.
        const importOriginal = async <T,>() => original as T;
        const reader = createUseSettingMock({ values: { scmGitPaneLayout: 'tabs' } });
        const partial = await createStorageModuleMock({ importOriginal, overrides: { useSetting: reader } });
        expect(partial.useSettingMutable('scmGitPaneLayout')[0]).toBe('tabs');

        const explicit = createStorageModuleStub({ useSettingMutable: partial.useSettingMutable });
        const preserved = await createStorageModuleMock({ importOriginal, overrides: {
            useSetting: createUseSettingMock({ values: { scmGitPaneLayout: 'unified' } }),
            useSettingMutable: explicit.useSettingMutable,
        } });
        expect(preserved.useSettingMutable('scmGitPaneLayout')[0]).toBe('tabs');

        const fixtureStorage = create<StorageState>(() => createStorageStoreMock({
            profileScope: { serverId: 'home', accountId: 'account' },
        }).getState());
        const storeModule = await createStorageStoreModuleMock({
            importOriginal: async <T,>() => ({ storage: original.storage, getStorage: original.getStorage }) as T,
            overrides: { storage: fixtureStorage },
        });
        expect(storeModule.getStorage()).toBe(storeModule.storage);
        const observedScopes: StorageState['profileScope'][] = [];
        const unsubscribe = storeModule.getStorage().subscribe((state) => observedScopes.push(state.profileScope));
        storeModule.storage.setState({ profileScope: { serverId: 'next-home', accountId: 'account' } });
        expect(observedScopes).toEqual([{ serverId: 'next-home', accountId: 'account' }]);
        expect(storeModule.getStorage().getState().profileScope).toEqual({ serverId: 'next-home', accountId: 'account' });
        unsubscribe();
        storeModule.storage.setState({ profileScope: undefined });
        expect(observedScopes).toHaveLength(1);
    });
});
