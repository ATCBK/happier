import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    cleanupWorkspaceFileDetailsActionBoundary,
    getWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsCommonModuleMocks,
    prepareWorkspaceFileDetailsActionBoundary,
} from './workspaceFileDetailsTestHelpers';

installWorkspaceFileDetailsCommonModuleMocks();
installWorkspaceFileDetailsActionBoundary();
const transport = vi.hoisted(() => ({ stat: vi.fn() }));
// Remote stat and platform hashing are system boundaries; range admission and decoding stay real.
vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({ callDaemonWorkspaceStatFileRpc: transport.stat }));
vi.mock('@/platform/digest', () => ({ digest: async () => new Uint8Array(32) }));
vi.mock('@/config', () => ({ config: { filesPreviewMaxBytes: 10 } }));

const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
const rpc = getWorkspaceFileDetailsActionBoundary();
let serverId: string;
beforeEach(async () => {
    serverId = await prepareWorkspaceFileDetailsActionBoundary();
    transport.stat.mockReset().mockResolvedValue({ success: true, exists: true, kind: 'file', sizeBytes: 14 });
    rpc.read.mockReset();
});
afterEach(cleanupWorkspaceFileDetailsActionBoundary);
const input = () => ({ scope: { serverId, machineId: 'm1', rootPath: '/repo' }, filePath: 'src/big.txt',
    diffMode: 'pending' as const, includeDiff: false });

describe('refreshWorkspaceFileDetails (preview budget)', () => {
    it('offers the existing head/tail budget without reading or reporting a failed read', async () => {
        const result = await refreshWorkspaceFileDetails(input());
        expect(result.error).toBeNull();
        expect(result.tooLarge).toEqual({ sizeBytes: 14, maxPreviewBytes: 10 });
        expect(result.fileContent).toBeNull();
        expect(result.fileWriteSupported).toBe(false);
        expect(rpc.read).not.toHaveBeenCalled();
    });

    it.each([
        { slice: 'head' as const, text: 'abcdefghi€jk', offset: 0, content: 'abcdefghi' },
        { slice: 'tail' as const, text: 'abc€defghijkl', offset: 5, content: 'defghijkl' },
    ])('reads the $slice range and trims only its incomplete UTF-8 edge', async ({ slice, text, offset, content }) => {
        const bytes = Buffer.from(text);
        transport.stat.mockResolvedValue({ success: true, exists: true, sizeBytes: bytes.length });
        rpc.read.mockResolvedValue({ success: true, content: bytes.subarray(offset, offset + 10).toString('base64'),
            sizeBytes: bytes.length, eof: offset + 10 >= bytes.length });
        const result = await refreshWorkspaceFileDetails({ ...input(), previewSlice: slice });
        expect(result.error).toBeNull();
        expect(result.fileWriteSupported).toBe(false);
        expect(result.fileContent).toMatchObject({ content, contentHash: null, isBinary: false,
            partial: { slice, offset, length: 10, totalBytes: bytes.length } });
        expect(rpc.calls).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({
            path: '/repo/src/big.txt', offset, length: 10,
        }) }));
    });

    it('keeps a file at the budget boundary complete and editable', async () => {
        transport.stat.mockResolvedValue({ success: true, exists: true, sizeBytes: 10 });
        rpc.read.mockResolvedValue({ success: true, content: Buffer.from('0123456789').toString('base64') });
        const result = await refreshWorkspaceFileDetails({ ...input(), previewSlice: 'tail' });
        expect(result.error).toBeNull();
        expect(result.fileWriteSupported).toBe(true);
        expect(result.fileContent?.content).toBe('0123456789');
        expect(result.fileContent?.partial).toBeUndefined();
    });

    it('surfaces a refused range through the ordinary read error', async () => {
        rpc.read.mockResolvedValue({ success: false, error: 'range unavailable' });
        const result = await refreshWorkspaceFileDetails({ ...input(), previewSlice: 'head' });
        expect(result.error).toBe('range unavailable');
        expect(result.fileContent).toBeNull();
    });
});
