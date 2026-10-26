import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-file-system', async () => (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);

let disposeCatalog: (() => void) | undefined;
afterEach(async () => { await standardCleanup(); disposeCatalog?.(); disposeCatalog = undefined; });

describe('Legacy Profile settings subscriptions', () => {
    it('ignores unrelated Settings writes and recomposes when backend enablement changes', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const store = getStorage();
        const previous = store.getState();
        const { getActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const catalog = await import('@/sync/store/settings/acpCatalogSnapshot');
        const engine = await import('@/sync/engine/settings/acpCatalogEngine');
        const scope = { serverId: getActiveServerId(), accountId: 'profile-editor-fixture' };
        store.setState({ settingsScope: scope });
        catalog.applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1,
            record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [] }) }, true);
        disposeCatalog = () => {
            engine.resetAcpCatalogEngineForTests();
            catalog.resetAcpCatalogSnapshotsForTests();
            store.setState({ settingsScope: previous.settingsScope, settings: previous.settings, settingsVersion: previous.settingsVersion });
        };
        const { LegacyProfileEditForm } = await import('./LegacyProfileEditForm');
        const profile = AIBackendProfileSchema.parse({ id: 'legacy-profile', name: 'Profile', environmentVariables: [],
            compatibility: { claude: true, codex: true, gemini: true }, isBuiltIn: true, createdAt: 1, updatedAt: 1, version: '1.0.0' });
        const commits = vi.fn<React.ProfilerOnRenderCallback>();
        await renderScreen(<React.Profiler id="legacy-profile" onRender={commits}>
            <LegacyProfileEditForm profile={profile} machineId={null} onSave={() => true} onCancel={() => {}} />
        </React.Profiler>);
        commits.mockClear();
        for (let index = 0; index < 20; index += 1) {
            await act(async () => store.setState(state => ({
                settings: { ...state.settings, showFlavorIcons: index % 2 === 0 }, settingsVersion: index + 2,
            })));
        }
        expect(commits).not.toHaveBeenCalled();
        await act(async () => store.setState(state => ({ settings: { ...state.settings, backendEnabledByTargetKey: {
            ...state.settings.backendEnabledByTargetKey,
            [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' })]: false,
        } } })));
        expect(commits).toHaveBeenCalled();
    });
});
