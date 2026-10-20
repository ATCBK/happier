import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcMock = vi.hoisted(() => vi.fn());
const getReadyServerFeaturesMock = vi.hoisted(() => vi.fn());
const directExportDownloadMock = vi.hoisted(() => vi.fn());
const resolveMachineCarrierRouteMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => machineRpcMock(...args),
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (...args: unknown[]) => getReadyServerFeaturesMock(...args),
}));

vi.mock('../plumbing/directTransferExportDownload', () => ({
    downloadBulkPayloadViaDirectExportToDestination: (...args: unknown[]) => directExportDownloadMock(...args),
}));

vi.mock('../plumbing/machineCarrierHttpLease', () => ({
    MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR: 'The direct machine connection was interrupted. Retry the transfer.',
    MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE: 'machine_carrier_transport_failed',
    resolveMachineCarrierRoute: (...args: unknown[]) => resolveMachineCarrierRouteMock(...args),
}));

// Load the real transfer graph during collection; each test resets its transport boundaries below.
const composerMediaStageTransfers = await import('./composerMediaStageTransfers');

describe('uploadComposerMediaStageFromReader', () => {
    afterEach(() => {
        machineRpcMock.mockReset();
        getReadyServerFeaturesMock.mockReset();
        directExportDownloadMock.mockReset();
        resolveMachineCarrierRouteMock.mockReset();
    });

    it('fails closed when an older daemon does not expose Composer media capability negotiation', async () => {
        const executionTarget = { serverId: 'server-current', machineId: 'machine-current' };
        getReadyServerFeaturesMock.mockResolvedValue(null);
        machineRpcMock.mockResolvedValue({
            error: 'Method not found',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });

        const { getComposerMediaContentAvailability } = composerMediaStageTransfers;

        await expect(getComposerMediaContentAvailability({ executionTarget })).resolves.toEqual({ available: false });
        expect(machineRpcMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1,
            payload: {},
        }));
    });

    it('accepts only the current daemon Composer media capability fact', async () => {
        const executionTarget = { serverId: 'server-current', machineId: 'machine-current' };
        getReadyServerFeaturesMock.mockResolvedValue(null);
        machineRpcMock.mockResolvedValue({
            success: true,
            available: true,
            capability: 'composer.mediaContent.v1',
        });

        const { getComposerMediaContentAvailability } = composerMediaStageTransfers;

        await expect(getComposerMediaContentAvailability({ executionTarget })).resolves.toEqual({
            available: true,
            capability: 'composer.mediaContent.v1',
        });
    });

    it('captures the source submission through the strict claim operation and requires its fork handle', async () => {
        const handle = { v: 1, id: 'source-stage',
            executionTarget: { serverId: 'server-current', machineId: 'machine-current' },
            owner: { pluginId: 'com.example.media', localId: 'composer' },
            mediaKind: 'image', mimeType: 'image/png', name: 'captured.png', sizeBytes: 5, sha256: 'a'.repeat(64),
        } as const;
        const capture = { sourceComposerRef: { kind: 'session', sessionId: 'source-session' },
            destinationComposerRef: { kind: 'session', sessionId: 'destination-session' },
            attachmentInstanceId: 'attachment-a', messageLocalId: 'ask-1',
        } as const;
        const fork = { ...handle, id: 'captured-stage' };
        getReadyServerFeaturesMock.mockResolvedValue(null);
        machineRpcMock.mockResolvedValue({ success: true, newlyAcquired: true, handle: fork });
        const { captureComposerContentSubmission } = composerMediaStageTransfers;
        await expect(captureComposerContentSubmission(handle, capture))
            .resolves.toEqual({ status: 'claimed', newlyAcquired: true, handle: fork });
        expect(machineRpcMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM,
            payload: { handle, claimant: { composer: capture.sourceComposerRef, attachmentInstanceId: capture.attachmentInstanceId },
                submission: { destinationComposerRef: capture.destinationComposerRef, messageLocalId: capture.messageLocalId } },
        }));
        machineRpcMock.mockResolvedValue({ success: true, newlyAcquired: false });
        await expect(captureComposerContentSubmission(handle, capture)).resolves.toEqual({ status: 'unavailable' });
        machineRpcMock.mockResolvedValue({ success: true, newlyAcquired: false, handle });
        await expect(captureComposerContentSubmission(handle, capture)).resolves.toEqual({ status: 'unavailable' });
        machineRpcMock.mockResolvedValue({ success: true, newlyAcquired: true, handle: { ...fork, sha256: 'b'.repeat(64) } });
        await expect(captureComposerContentSubmission(handle, capture)).resolves.toEqual({ status: 'unavailable' });
        machineRpcMock.mockClear();
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(captureComposerContentSubmission(handle, capture, { signal: cancelled.signal }))
            .resolves.toEqual({ status: 'unavailable' });
        expect(machineRpcMock).not.toHaveBeenCalled();
    });

    it('inspects a bounded opaque stage range and releases it through the same target-scoped transfer caller', async () => {
        const executionTarget = { serverId: 'server-current', machineId: 'machine-current' };
        const owner = { pluginId: 'com.example.media', localId: 'composer' };
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const handle = {
            v: 1 as const,
            id: 'opaque-content-2',
            executionTarget,
            owner,
            mediaKind: 'image' as const,
            mimeType: 'image/png' as const,
            name: 'camera.png',
            sizeBytes: bytes.byteLength,
            sha256,
        };
        const calls: Array<Readonly<{ method: string; payload: unknown }>> = [];
        const acquire = vi.fn(async () => ({
            kind: 'native_http' as const,
            localOrigin: 'http://127.0.0.1:48124',
            release: vi.fn(),
        }));
        resolveMachineCarrierRouteMock.mockResolvedValue({ kind: 'iroh_peer', acquire });
        directExportDownloadMock.mockImplementation(async (input: Readonly<{
            request: unknown;
            destination: { writeBytes: (bytes: Uint8Array) => Promise<void> };
            acquirePreparedCarrier: (prepared: { operationId: string }) => Promise<unknown>;
        }>) => {
            await input.acquirePreparedCarrier({ operationId: 'inspection-1' });
            await input.destination.writeBytes(bytes.subarray(2, 4));
            return { ok: true, name: handle.name, sizeBytes: 2 };
        });
        getReadyServerFeaturesMock.mockResolvedValue(null);
        machineRpcMock.mockImplementation(async (input: Readonly<{ method: string; payload: unknown }>) => {
            calls.push(input);
            if (input.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE) {
                return { success: true };
            }
            throw new Error(`Unexpected machine RPC method: ${input.method}`);
        });

        const { inspectComposerContent, releaseComposerContent } = composerMediaStageTransfers;
        const inspection = await inspectComposerContent(handle, { offset: 2, maxBytes: 2 }, { sessionId: 'session-a' });
        expect(inspection).toEqual({
            success: true,
            result: {
                offset: 2,
                bytesBase64: Buffer.from(bytes.subarray(2, 4)).toString('base64'),
                eof: false,
            },
        });
        const claimant = {
            composer: { kind: 'session' as const, sessionId: 'session-1' },
            attachmentInstanceId: 'attachment-1',
        };
        await expect(releaseComposerContent(handle, { claimant })).resolves.toEqual({ success: true });
        expect(directExportDownloadMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-current',
            serverId: 'server-current',
            request: {
                t: 'composer_media_stage_inspect_v1',
                sessionId: 'session-a',
                handle,
                offset: 2,
                maxBytes: 2,
            },
            acquirePreparedCarrier: expect.any(Function),
        }));
        expect(resolveMachineCarrierRouteMock).toHaveBeenCalledWith('machine-current', 'server-current');
        expect(acquire).toHaveBeenCalledWith({
            operationId: 'inspection-1',
            signal: undefined,
        });
        expect(calls.some((call) => call.method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT)).toBe(false);
        expect(calls.find((call) => call.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE)).toEqual(expect.objectContaining({
            payload: { handle, claimant },
        }));
    });

    it('does not fall back to Composer chunk RPC after iroh_peer inspection is selected', async () => {
        const handle = {
            v: 1 as const,
            id: 'opaque-content-3',
            executionTarget: { serverId: 'server-b', machineId: 'machine-b' },
            owner: { pluginId: 'com.example.media', localId: 'composer' },
            mediaKind: 'image' as const,
            mimeType: 'image/png' as const,
            name: 'camera.png',
            sizeBytes: 5,
            sha256: 'a'.repeat(64),
        };
        resolveMachineCarrierRouteMock.mockResolvedValue({ kind: 'iroh_peer', acquire: vi.fn() });
        directExportDownloadMock.mockImplementation(async (input: Readonly<{
            acquirePreparedCarrier: (prepared: { operationId: string }) => Promise<unknown>;
        }>) => {
            await input.acquirePreparedCarrier({ operationId: 'inspection-2' });
            return {
                ok: false,
                error: 'The direct machine connection was interrupted. Retry the transfer.',
                errorCode: 'machine_carrier_transport_failed',
            };
        });

        const { inspectComposerContent } = composerMediaStageTransfers;
        await expect(inspectComposerContent(handle, { offset: 0, maxBytes: 2 })).resolves.toEqual({
            success: false,
            error: 'The direct machine connection was interrupted. Retry the transfer.',
            errorCode: 'machine_carrier_transport_failed',
        });
        expect(machineRpcMock).not.toHaveBeenCalled();
    });
});
