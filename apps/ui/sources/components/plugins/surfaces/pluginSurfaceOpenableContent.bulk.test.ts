import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { PluginUiHostApiRequestEnvelopeV1Schema } from '@happier-dev/protocol/plugins/ui';

import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';

import {
    createPluginSurfaceOpenableContentHandlers,
    createWorkspaceFileOpenableContentBinding,
} from './pluginSurfaceOpenableContent';

describe('plugin surface openable content bulk delivery', () => {
    let boundary: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>> | undefined;
    afterEach(async () => { await boundary?.reset(); });

    it('uses the caller ceiling above the private inline default and keeps a lower caller ceiling typed', async () => {
        const sizeBytes = 300 * 1024;
        const bytes = new Uint8Array(sizeBytes);
        const contentHash = bytesToHex(sha256(bytes));
        boundary = await createWorkspaceFileDownloadHarness({ name: 'preview.png', bytes });
        boundary.setStatResponse({ success: true, exists: true, kind: 'file', sizeBytes,
            modifiedMs: 100, changedMs: 100, contentHash });
        const binding = createWorkspaceFileOpenableContentBinding({
            target: boundary.scope,
            filePath: 'notes/preview.png',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });
        const revision = `workspace-file:${sizeBytes}:${contentHash}`;
        const request = (maxBytes: number) => PluginUiHostApiRequestEnvelopeV1Schema.parse({
            version: 1,
            requestId: `read:${maxBytes}`,
            surface: { pluginId: 'acme.viewer', contributionId: 'image-viewer', surfaceId: 'surface:viewer',
                placement: 'sessionPane', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
            method: 'readOpenableContent',
            payload: { ref: binding.ref, expectedRevision: revision, maxBytes },
        });

        await expect(handlers.readOpenableContent!(request(256 * 1024)))
            .resolves.toEqual({ status: 'tooLarge', sizeBytes });
        expect(boundary.rpcRequests.filter(call => call.method === 'daemon.filesystem.download')).toEqual([]);

        await expect(handlers.readOpenableContent!(request(sizeBytes))).resolves.toMatchObject({
            status: 'ready', revision,
            content: { kind: 'base64', base64: 'AAAA'.repeat(sizeBytes / 3) },
        });
        expect(boundary.rpcRequests).toContainEqual(expect.objectContaining({
            method: 'daemon.filesystem.download',
            payload: expect.objectContaining({ input: expect.objectContaining({
                rootPath: boundary.scope.rootPath,
                path: `${boundary.scope.rootPath}/notes/preview.png`,
            }) }),
        }));
    });
});
