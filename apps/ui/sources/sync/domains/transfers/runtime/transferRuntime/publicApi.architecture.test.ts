import { access, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Compile the real export graph during collection rather than spending the
// behavior assertion's budget on cold module transforms.
const transferRuntime = await import('./index');

async function listFilesRecursively(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            results.push(...(await listFilesRecursively(path)));
        } else {
            results.push(path);
        }
    }
    return results;
}

describe('transferRuntime (public API)', () => {
    it('freezes the transferRuntime index runtime exports', async () => {
        expect(Object.keys(transferRuntime).sort()).toEqual([
            'MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE',
            'MACHINE_CARRIER_UNAVAILABLE_ERROR_CODE',
            'callAdmittedFilesystemTransferActionRpc',
            'callDaemonWorkspaceStatFileRpc',
            'callDaemonWorkspaceWriteFileRpc',
            'captureComposerContentSubmission',
            'claimComposerContent',
            'classifyTransferFailure',
            'copyPreparedFilesystemFile',
            'createSessionAttachmentTransferRouting',
            'createTransferFinalizeRecovery',
            'createTransferManifestHasher',
            'downloadBulkPayloadViaDirectExportToDestination',
            'downloadDaemonSessionAttachmentToDestination',
            'downloadDaemonWorkspaceFileToBase64',
            'downloadDaemonWorkspaceFileToDestination',
            'downloadRegistrySkillFiles',
            'getComposerMediaContentAvailability',
            'inspectComposerContent',
            'isTransferFinalizeRecoveryFailure',
            'observeTransferOperation',
            'prepareBulkJsonPayloadForUpload',
            'readFoundSkillBundle',
            'readTransferFailureCode',
            'releaseComposerContent',
            'resolveMachineCarrierRoute',
            'resolveSessionFileTransferAvailability',
            'resolveTransferAvailability',
            'resolveTransferRouteDecision',
            'retainTransferFinalizeRecovery',
            'settleTransferFinalizeRecovery',
            'uploadBulkPayloadFromFileViaMachineCarrier',
            'uploadComposerMediaStageFromReader',
            'uploadDaemonSessionAttachmentFromReader',
            'uploadDaemonWorkspaceFileFromReader',
        ]);
    });

    it('requires the new transferRuntime subfolders to exist', async () => {
        const transferRuntimePath = fileURLToPath(new URL('./', import.meta.url));
        const expectedSubfolders = [
            'availability',
            'routing',
            'families',
            'carriers',
            'plumbing',
        ] as const;

        for (const subfolder of expectedSubfolders) {
            await expect(access(join(transferRuntimePath, subfolder))).resolves.toBeUndefined();
        }
    });

    it('does not retain legacy transfer folders or imports anywhere under apps/ui/sources', async () => {
        const legacyFolderTokens = [
            ['bulk', 'Transfer', 'Pipeline'].join(''),
            ['transfer', 'Substrate'].join(''),
        ] as const;
        const sourcesPath = fileURLToPath(new URL('../../../../../', import.meta.url));
        const files = (await listFilesRecursively(sourcesPath)).filter((filePath) =>
            filePath.endsWith('.ts') || filePath.endsWith('.tsx'),
        );

        const legacyReferences: string[] = [];
        for (const filePath of files) {
            const source = await readFile(filePath, 'utf8');
            if (legacyFolderTokens.some((token) => source.includes(token))) {
                legacyReferences.push(relative(sourcesPath, filePath));
            }
        }

        expect(legacyReferences.sort()).toEqual([]);
    });

    it('keeps plumbing imports scoped to transferRuntime/**', async () => {
        const sourcesPath = fileURLToPath(new URL('../../../../../', import.meta.url));
        const files = (await listFilesRecursively(sourcesPath)).filter((filePath) =>
            (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
            && !filePath.endsWith('.test.ts')
            && !filePath.endsWith('.spec.ts')
            && !filePath.endsWith('.test.tsx')
            && !filePath.endsWith('.spec.tsx')
            // Network/native fixture producers exercise these private codecs;
            // they are test support, not product transfer entry points.
            && !relative(sourcesPath, filePath).replaceAll('\\', '/').startsWith('dev/testkit/')
            && !/(?:Testkit|\.testHarness)\.tsx?$/.test(filePath),
        );

        const externalPlumbingImports: string[] = [];
        for (const filePath of files) {
            if (filePath.includes('/sync/domains/transfers/runtime/transferRuntime/')) {
                continue;
            }

            const source = await readFile(filePath, 'utf8');
            if (source.includes('/sync/domains/transfers/runtime/transferRuntime/plumbing/')) {
                externalPlumbingImports.push(relative(sourcesPath, filePath));
            }
        }

        expect(externalPlumbingImports.sort()).toEqual([]);
    });
});
