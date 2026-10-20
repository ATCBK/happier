import { describe, expect, it } from 'vitest';

import { createSaplingScmBackendRegistration } from './backend.js';
import { SAPLING_SCM_BACKEND_CAPABILITIES } from './capabilities.js';

describe('Sapling SCM backend capability projection', () => {
    it('explicitly declines base-revision byte reads', async () => {
        expect(SAPLING_SCM_BACKEND_CAPABILITIES.read.fileAtRevision.support).toBe('unsupported');
        const reader = createSaplingScmBackendRegistration().handlers.read?.fileAtRevision;
        expect(reader).toBeTypeOf('function');
        if (!reader) return;
        expect(await reader({ context: { cwd: '/repo', projectKey: 'machine:/repo',
            detection: { isRepo: true, rootPath: '/repo', mode: '.sl' } },
            request: { path: 'image.png', selector: { side: 'before', area: 'pending' } }, signal: new AbortController().signal })).toEqual({
            success: false, errorCode: 'unsupported',
        });
    });
    it('derives unavailable leaves through the canonical repository-mode policy', async () => {
        const describeBackend = createSaplingScmBackendRegistration().handlers.detection?.describeBackend;
        expect(describeBackend).toEqual(expect.any(Function));
        if (!describeBackend) return;

        const response = await describeBackend({
            context: {
                cwd: '/repo',
                projectKey: 'machine:/repo',
                detection: { isRepo: false, rootPath: null, mode: null },
            },
        });

        expect(response.capabilities?.readStatus).toBe(false);
        expect(response.capabilities?.writeCommit).toBe(false);
    });
});
