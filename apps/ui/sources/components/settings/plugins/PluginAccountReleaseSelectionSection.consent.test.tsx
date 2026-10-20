import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const confirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { confirm } }).module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { PluginAccountReleaseSelectionSection } = await import('./PluginAccountReleaseSelectionSection');
const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
// Consent is dispatched through the real Action front door. Its cold graph is
// collection setup rather than part of the interaction under test.
await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');

afterEach(async () => { standardCleanup(); await account.reset(); confirm.mockClear(); });

it('requires a hosting disclosure decision before enabling Account storage', async () => {
    const pluginId = 'example.brand';
    await account.restore({ accountId: 'account-a', currentAccount: true,
        serverIdentityId: 'srv_plugin_hosting_consent', machines: [] });
    const scope = { serverId: account.serverId, accountId: 'account-a' };
    // The row and real Account Action must read the same admitted Availability projection.
    replacePluginAccountAvailabilityProjection({
        scope,
        snapshot: {
            availabilityCursor: 4, materializations: [], snapshots: [],
            intentReads: [{ pluginId, response: {
                availabilityCursor: 4,
                hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                intent: { pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
                release: {
                    ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest: PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Brand', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { resources: [{ id: 'brand', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }] } }),
                    collectionContracts: [],
                    uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [{ resourceId: 'brand', path: 'assets/brand.png', mimeType: 'image/png', byteSize: 3, digestSha256: `sha256:${'d'.repeat(64)}` }] },
                }, uiArtifacts: [], packageAssets: [],
            } }],
        },
    });
    const reader = readPluginAccountAvailability(scope);
    const screen = await renderScreen(<PluginAccountReleaseSelectionSection
        pluginId={pluginId} version={null} reader={reader} projection={null}
        daemon={{ serverId: null, serverIdentityId: null, machineId: null }} testID="release"
    />);
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.findByTestId('release.hosting')).not.toBeNull();
    await act(async () => { screen.findByTestId('release.hosting')?.props.onPress(); });
    await waitForHomeGovernance(() => expect(confirm).toHaveBeenCalledOnce());
    expect(reader.readCurrentReleaseSelection({ pluginId })).toMatchObject({ kind: 'available', intent: { offlineUiHosting: 'disabled' } });
    expect(screen.findByTestId('release.clearCache')).toBeNull();
    expect(account.home.requestsFor(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.set'])).toHaveLength(0);
});
