import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptAssetTypeDescriptorV1 } from '@happier-dev/protocol';
import { DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER } from '@happier-dev/protocol/machines/transfer/directPeerUrls';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { TransferFinalizeRecoveryAction } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import {
    createPromptMachineTransferFixture,
    installPromptMachineSocketBoundary,
} from '@/dev/testkit/harness/promptMachineTransferBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@happier-dev/iroh-native', async original => (await import('@/dev/testkit/harness/promptMachineTransferBoundary')).createPromptNativeTransferModuleBoundary(original));
installPromptMachineSocketBoundary();

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: (config) => {
        const resolve: unknown = Reflect.get(config.props ?? {}, 'onResolve');
        if (typeof resolve !== 'function') throw new Error('Expected a recovery action selector');
        const recoveryAction: TransferFinalizeRecoveryAction = 'retry_finalize';
        resolve(recoveryAction);
        return 'recovery-modal';
    } } }).module;
});

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'link-1',
}));

const { storage } = await import('@/sync/domains/state/storage');
const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiPromptLibraryArtifactStore } = await import('./promptLibraryArtifactStore');
const { writePromptLibraryArtifactToExternalAsset } = await import('./exportPromptLibraryArtifact');
const docType: PromptAssetTypeDescriptorV1 = {
    id: 'claude.command', providerId: 'claude', title: 'Commands', description: 'Markdown',
    libraryKind: 'doc', supportsScope: { user: true, project: true }, supportsFiles: false,
    formatId: 'markdown_utf8_v1', defaultRoots: [], capabilities: {},
};
let fixture: Awaited<ReturnType<typeof createPromptMachineTransferFixture>>;
let account: LazyActionAccountContext;
let previousState: ReturnType<typeof storage.getState>;
afterEach(async () => {
    vi.restoreAllMocks();
    account?.dispose();
    await fixture?.dispose();
    storage.setState(previousState, true);
});

describe('writePromptLibraryArtifactToExternalAsset', () => {
    beforeEach(async () => {
        previousState = storage.getState();
        const catalog = createPromptLibraryCatalogBoundary();
        fixture = await createPromptMachineTransferFixture({
            serverUrl: 'https://prompt-export-operations.test',
            serverIdentityId: 'srv_prompt_export_operations',
            selectionKey: MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptAssets,
            types: [docType], handleHomeRequest: catalog.handle,
        });
        account = await captureLazyActionAccountContext(fixture.scope.serverId);
        await account.workflowArtifacts.create({
            artifactId: 'doc-1', header: { v: 1, kind: 'prompt_doc.v2', title: 'Review prompt' },
            body: JSON.stringify({ v: 1, markdown: '# Review', createdAtMs: 1, updatedAtMs: 1 }),
        });
    });

    it('finishes a retained prompt upload without issuing another write', async () => {
        const transport = await import('@/utils/system/runtimeFetch');
        const originalFetch = transport.runtimeFetch;
        const finalizations: string[] = [];
        // Only the genuine HTTP boundary fails; retry retains the real session,
        // encrypted bytes, carrier reacquisition and finalize parser.
        vi.spyOn(transport, 'runtimeFetch').mockImplementation(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/finalize')) {
                finalizations.push(url.pathname);
                if (finalizations.length === 1) return Response.json({
                    success: false, error: 'Finalize recovery is required',
                    errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED', keepSession: true,
                }, { status: 500, headers: { [DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER]: String(Date.now() + 60_000) } });
            }
            return originalFetch(input, init);
        });

        const result = await writePromptLibraryArtifactToExternalAsset({
            artifactId: 'doc-1',
            machineId: 'machine-1',
            machineTarget: { serverIdentityId: 'srv_prompt_export_operations', machineId: 'machine-1' },
            libraryServerIdentityId: 'srv_prompt_export_operations',
            assetTypeId: 'claude.command',
            scope: 'user',
            targetInput: 'review.md',
            promptExternalLinks: { v: 1, links: [{
                id: 'link-1', artifactId: 'doc-1', assetTypeId: docType.id, machineId: 'machine-1',
                serverIdentityId: 'srv_prompt_export_operations', scope: 'user',
                externalRef: { relativePath: 'review.md' }, lastExternalDigest: 'digest-previous',
            }] },
            previewOnly: false,
            serverId: fixture.serverId,
        }, createUiPromptLibraryArtifactStore(account.workflowArtifacts));

        expect(result, JSON.stringify({ result, finalizations, uploadedRequests: fixture.uploadedRequests })).toMatchObject({ ok: true, response: { digest: 'digest-1' } });
        expect(fixture.daemonRequests.filter(request => request.method.endsWith(':daemon.directTransfer.import.prepare')))
            .toMatchObject([{ method: 'machine-1:daemon.directTransfer.import.prepare', params: { t: 'prompt_asset_upload_v1' } }]);
        expect(fixture.uploadedRequests).toMatchObject([{
            assetTypeId: docType.id, scope: 'user', targetPath: 'review.md', markdown: '# Review', previewOnly: false,
        }]);
        expect(finalizations).toEqual([
            '/machine-transfers/direct/imports/prompt-screen-import/finalize',
            '/machine-transfers/direct/imports/prompt-screen-import/finalize',
        ]);
        expect(fixture.daemonRequests.filter(request => request.method.endsWith(':daemon.directTransfer.import.abort'))).toEqual([]);
        expect(result).toMatchObject({ nextPromptExternalLinks: { v: 1, links: [{
            id: 'link-1', artifactId: 'doc-1', lastExternalDigest: 'digest-1',
        }] } });
    });

    it('passes server routing through to machine prompt asset writes', async () => {
        const machineHome = await fixture.addMachineHome('https://prompt-export-machine.test', 'srv_prompt_export_machine');
        fixture.daemonRequests.length = 0;
        fixture.homes.requests.length = 0;

        const result = await writePromptLibraryArtifactToExternalAsset({
            artifactId: 'doc-1',
            machineId: 'machine-2',
            machineTarget: { serverIdentityId: 'srv_prompt_export_machine', machineId: 'machine-2' },
            libraryServerIdentityId: 'srv_prompt_export_operations',
            assetTypeId: 'claude.command',
            scope: 'user',
            targetInput: 'review.md',
            promptExternalLinks: { v: 1, links: [] },
            previewOnly: false,
            serverId: machineHome.serverId,
        }, createUiPromptLibraryArtifactStore(account.workflowArtifacts));

        expect(result).toMatchObject({ ok: true });
        expect(fixture.daemonRequests.filter(request => request.method.endsWith(':daemon.directTransfer.import.prepare')))
            .toMatchObject([{ method: 'machine-2:daemon.directTransfer.import.prepare' }]);
        expect(fixture.uploadedRequests).toMatchObject([{
            assetTypeId: docType.id, targetPath: 'review.md', markdown: '# Review', previewOnly: false,
        }]);
        expect(fixture.homes.requestsFor('/v1/machines/peer/mediation/route-grants')).toMatchObject([{
            serverId: machineHome.serverId, input: { machineId: 'machine-2' },
        }]);
        expect(result).toMatchObject({ nextPromptExternalLinks: { links: [{
            serverIdentityId: 'srv_prompt_export_machine', machineId: 'machine-2',
            artifactId: 'doc-1', lastExternalDigest: 'digest-1',
        }] } });
        expect(fixture.artifacts.list().map(artifact => artifact.id)).toEqual(['doc-1']);
        expect(machineHome.artifacts.list()).toEqual([]);
    });
});
