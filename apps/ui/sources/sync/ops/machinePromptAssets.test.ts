import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPromptAssetsCommonModuleMocks } from '@/components/settings/prompts/assets/promptAssetsScreenTestHelpers';
import type { PromptAssetTypeDescriptorV1, PromptAssetWriteRequest } from '@happier-dev/protocol';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@happier-dev/iroh-native', async original => (await import('@/dev/testkit/harness/promptMachineTransferBoundary')).createPromptNativeTransferModuleBoundary(original));
installPromptAssetsCommonModuleMocks({ storage: original => original(), reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: ({ ios, default: fallback }: { ios?: unknown; default?: unknown }) => ios ?? fallback } });
} });
const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
installHomeGovernanceBoundaries(createHomeGovernanceHarness());
const { createPromptLibraryCatalogBoundary } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { createPromptMachineTransferFixture, installPromptMachineSocketBoundary } = await import('@/dev/testkit/harness/promptMachineTransferBoundary');
installPromptMachineSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { machinePromptAssetsListTypes, machinePromptAssetsWrite, machinePromptAssetsDelete } = await import('./machinePromptAssets');
let fixture: Awaited<ReturnType<typeof createPromptMachineTransferFixture>>;
let previousState: ReturnType<typeof storage.getState>;
const type: PromptAssetTypeDescriptorV1 = { id: 'agents.skill', providerId: 'agents', title: 'Skills', description: 'Skills', libraryKind: 'bundle',
    supportsScope: { user: true, project: true }, supportsFiles: true, formatId: 'skill_md_v1', defaultRoots: [],
    capabilities: { supportsSymlinkInstall: false } };
beforeEach(async () => {
    previousState = storage.getState(); const catalog = createPromptLibraryCatalogBoundary();
    fixture = await createPromptMachineTransferFixture({ serverUrl: 'https://legacy-prompt-assets.test', serverIdentityId: 'srv_legacy_prompt_assets',
        selectionKey: 'prompts.assets', types: [type], handleHomeRequest: catalog.handle });
});
afterEach(async () => { await fixture?.dispose(); storage.setState(previousState, true); });

describe('retained legacy export transport', () => {
    it('lists legacy export destinations and deletes through the admitted Machine RPC', async () => {
        expect(await machinePromptAssetsListTypes('machine-1', { serverId: fixture.serverId })).toEqual({ ok: true, types: [type] });
        expect(await machinePromptAssetsDelete('machine-1', { assetTypeId: type.id, scope: 'user', externalRef: { name: 'sample' } },
            { serverId: fixture.serverId })).toMatchObject({ ok: true });
        expect(fixture.daemonRequests.at(-1)).toMatchObject({ method: 'machine-1:daemon.promptAssets.delete',
            params: { assetTypeId: type.id, scope: 'user', externalRef: { name: 'sample' } } });
    });
    it('uploads legacy export bytes through the real finite carrier and strict finalize parser', async () => {
        const request: PromptAssetWriteRequest = { assetTypeId: type.id, scope: 'user', externalRef: null, targetName: 'sample', title: 'Sample',
            bundleSchemaId: 'skills.skill_md_v1', bundleBody: { v: 1, entries: [
                { path: 'SKILL.md', contentBase64: Buffer.from('# Sample').toString('base64'), contentKind: 'utf8', unixMode: 0o644 },
            ], createdAtMs: 1, updatedAtMs: 1 }, previewOnly: false, expectedDigest: null };
        expect(await machinePromptAssetsWrite('machine-1', request, { serverId: fixture.serverId })).toMatchObject({ ok: true, externalRef: { skillName: 'sample' } });
        expect(fixture.uploadedRequests).toEqual([request]);
    });
});
