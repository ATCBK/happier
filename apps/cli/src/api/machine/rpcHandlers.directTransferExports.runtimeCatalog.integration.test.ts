import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineRpcHandlers } from './rpcHandlers';

type Handler = (data: unknown) => Promise<unknown>;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
    const handlers = new Map<string, Handler>();
    return {
        handlers,
        registerHandler(method, handler) {
            handlers.set(method, handler);
        },
    };
}

describe('rpcHandlers (direct transfer exports)', () => {
    it('registers the direct transfer export prepare handler when available', () => {
        const mgr = createRpcHandlerManager();

        registerMachineRpcHandlers({
            rpcHandlerManager: mgr as any,
            handlers: {
                spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                stopSession: async () => true,
                requestShutdown: () => {},
                directTransferExport: {
                    prepareExportSession: async () => ({
                        transferId: 'transfer-1',
                        endpointCandidates: [],
                        expiresAt: 5_000,
                    }),
                    releaseExportSession: () => undefined,
                },
            },
        });

        expect(mgr.handlers.has(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)).toBe(true);
        expect(mgr.handlers.has(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE)).toBe(true);
    });

    it('delegates idempotent prepared-export release through the guarded export owner', async () => {
        const releaseExportSession = vi.fn(() => undefined);
        const mgr = createRpcHandlerManager();

        registerMachineRpcHandlers({
            rpcHandlerManager: mgr as any,
            handlers: {
                spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                stopSession: async () => true,
                requestShutdown: () => {},
                directTransferExport: {
                    prepareExportSession: async () => ({ transferId: 'transfer-release', endpointCandidates: [], expiresAt: 5_000 }),
                    releaseExportSession,
                },
            },
        });

        const handler = mgr.handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE);
        if (!handler) throw new Error('expected direct transfer export release handler');

        await expect(handler({ transferId: 'transfer-release' })).resolves.toEqual({ success: true });
        await expect(handler({ transferId: 'transfer-release' })).resolves.toEqual({ success: true });
        expect(releaseExportSession).toHaveBeenCalledTimes(2);
        expect(releaseExportSession).toHaveBeenNthCalledWith(1, 'transfer-release');
    });

    it('delegates Found skill export prepare through the registered direct transfer export handler', async () => {
        const prepareExportSession = vi.fn(async () => ({
            transferId: 'transfer-1',
            endpointCandidates: [
                {
                    kind: 'http' as const,
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-1',
                    expiresAt: 5_000,
                },
            ],
            expiresAt: 5_000,
        }));
        const mgr = createRpcHandlerManager();

        registerMachineRpcHandlers({
            rpcHandlerManager: mgr as any,
            handlers: {
                spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                stopSession: async () => true,
                requestShutdown: () => {},
                directTransferExport: {
                    prepareExportSession,
                },
            },
        });

        const handler = mgr.handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE);
        if (!handler) {
            throw new Error('expected direct transfer export prepare handler');
        }

        await expect(handler({
            t: 'prompt_asset_download_v1',
            path: '/skills/writer',
        })).resolves.toEqual({
            success: true,
            transferId: 'transfer-1',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-1',
                    expiresAt: 5_000,
                },
            ],
            expiresAt: 5_000,
        });
        expect(prepareExportSession).toHaveBeenCalledWith({
            t: 'prompt_asset_download_v1',
            path: '/skills/writer',
        });
    });

    it('delegates prompt registry export prepare through the registered direct transfer export handler', async () => {
        const prepareExportSession = vi.fn(async () => ({
            transferId: 'transfer-2',
            endpointCandidates: [
                {
                    kind: 'http' as const,
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-2',
                    expiresAt: 7_500,
                },
            ],
            expiresAt: 7_500,
        }));
        const mgr = createRpcHandlerManager();

        registerMachineRpcHandlers({
            rpcHandlerManager: mgr as any,
            handlers: {
                spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                stopSession: async () => true,
                requestShutdown: () => {},
                directTransferExport: {
                    prepareExportSession,
                },
            },
        });

        const handler = mgr.handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE);
        if (!handler) {
            throw new Error('expected direct transfer export prepare handler');
        }

        await expect(handler({
            t: 'prompt_registry_download_v1',
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            version: '1'.repeat(40),
            kind: 'skill',
        })).resolves.toEqual({
            success: true,
            transferId: 'transfer-2',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-2',
                    expiresAt: 7_500,
                },
            ],
            expiresAt: 7_500,
        });
        expect(prepareExportSession).toHaveBeenCalledWith({
            t: 'prompt_registry_download_v1',
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            version: '1'.repeat(40),
            kind: 'skill',
        });
    });

    it('delegates workspace file export prepare through the registered direct transfer export handler', async () => {
        const prepareExportSession = vi.fn(async () => ({
            transferId: 'transfer-3',
            endpointCandidates: [
                {
                    kind: 'http' as const,
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-3',
                    expiresAt: 9_000,
                },
            ],
            expiresAt: 9_000,
            name: 'hello.txt',
            sizeBytes: 5,
        }));
        const mgr = createRpcHandlerManager();

        registerMachineRpcHandlers({
            rpcHandlerManager: mgr as any,
            handlers: {
                spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                stopSession: async () => true,
                requestShutdown: () => {},
                directTransferExport: {
                    prepareExportSession,
                },
            },
        });

        const handler = mgr.handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE);
        if (!handler) {
            throw new Error('expected direct transfer export prepare handler');
        }

        await expect(handler({
            t: 'workspace_file_download_v1',
            workingDirectory: '/repo',
            path: '/repo/hello.txt',
            asZip: false,
        })).resolves.toEqual({
            success: true,
            transferId: 'transfer-3',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer-3',
                    expiresAt: 9_000,
                },
            ],
            expiresAt: 9_000,
            name: 'hello.txt',
            sizeBytes: 5,
        });
        expect(prepareExportSession).toHaveBeenCalledWith({
            t: 'workspace_file_download_v1',
            workingDirectory: '/repo',
            path: '/repo/hello.txt',
            asZip: false,
        });
    });

    it('delegates a bounded Composer media inspection to the same direct export prepare owner', async () => {
        const prepareExportSession = vi.fn(async () => ({
            transferId: 'composer-inspection-1',
            endpointCandidates: [],
            expiresAt: 9_000,
            name: 'camera.png',
            sizeBytes: 2,
        }));
        const mgr = createRpcHandlerManager();
        registerMachineRpcHandlers({
            rpcHandlerManager: mgr as any,
            handlers: {
                spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                stopSession: async () => true,
                requestShutdown: () => {},
                directTransferExport: { prepareExportSession },
            },
        });
        const handler = mgr.handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE);
        if (!handler) throw new Error('expected direct transfer export prepare handler');
        const request = {
            t: 'composer_media_stage_inspect_v1',
            handle: {
                v: 1,
                id: 'opaque-content-1',
                executionTarget: { serverId: 'server-b', machineId: 'machine-b' },
                owner: { pluginId: 'com.example.media', localId: 'composer' },
                mediaKind: 'image',
                mimeType: 'image/png',
                name: 'camera.png',
                sizeBytes: 5,
                sha256: 'a'.repeat(64),
            },
            offset: 2,
            maxBytes: 2,
        } as const;

        await expect(handler(request)).resolves.toMatchObject({
            success: true,
            transferId: 'composer-inspection-1',
            name: 'camera.png',
            sizeBytes: 2,
        });
        expect(prepareExportSession).toHaveBeenCalledWith(request);
    });
});
