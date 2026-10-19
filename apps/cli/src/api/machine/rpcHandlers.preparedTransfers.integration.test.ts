import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { PreparedTransferRpcResponseV1Schema } from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import { TransferChunkEnvelopeSchema } from '@happier-dev/protocol/machines/transfer/transferStream';
import { createEncryptedTransferChunkEnvelope, createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { prepareWorkspaceFileExport } from '@/machines/transfer/prepareWorkspaceFileExport';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineRpcHandlers } from './rpcHandlers';

it('serves an approved workspace export through registered prepared RPC phases and settles its original owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-prepared-rpc-seam-'));
  const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
  const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger() {} });
  const registration = registerMachineRpcHandlers({ rpcHandlerManager: manager, handlers: {
    spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Unavailable in transfer test' }),
    stopSession: async () => true, requestShutdown() {},
    preparedMachineTransfer: { request: input => lifecycle.requestPreparedTransfer(input) },
  } });
  try {
    const bytes = Buffer.from([0, 255, 128, 10]);
    await writeFile(join(directory, 'binary.bin'), bytes);
    const scope = { rootPath: directory, requesterAccountId: 'account', destinationId: 'browser' };
    const prepared = await prepareWorkspaceFileExport({ lifecycle, filesystemScope: scope,
      request: { workingDirectory: directory, path: 'binary.bin', asZip: false } });
    const endpoint = prepared.endpointCandidates[0];
    if (!endpoint?.authorizationToken) throw new Error('Prepared capability is unavailable');
    const basePath = new URL(endpoint.url).pathname;
    const recipient = createTransferRecipientKeyPair();
    const request = { t: 'prepared_machine_transfer_v1' as const,
      authorizationToken: endpoint.authorizationToken, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
    const call = async (method: string, path: string, httpMethod: 'GET' | 'POST', body?: unknown) =>
      PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(method, { ...request, path, httpMethod, ...(body === undefined ? {} : { body }) }));
    const opened = await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, `${basePath}/open`, 'POST');
    expect(opened.status).toBe(200);
    expect(JSON.parse(opened.body)).toMatchObject({ transferId: prepared.transferId, sizeBytes: bytes.length });
    const refused = PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
      { ...request, authorizationToken: 'wrong-capability', path: `${basePath}/chunks/0`, httpMethod: 'GET' }));
    expect(refused.status).toBe(401);
    await expect(manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
      { ...request, path: `${basePath}/chunks/0`, httpMethod: 'GET' })).resolves.toMatchObject({ errorCode: 'invalid_request' });
    const chunkResponse = await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, `${basePath}/chunks/0`, 'GET');
    expect(chunkResponse.status).toBe(200);
    const chunk = TransferChunkEnvelopeSchema.parse(JSON.parse(chunkResponse.body));
    if (chunk.kind !== 'chunk' || !chunk.encryptedDataKeyEnvelopeBase64) throw new Error('Encrypted chunk required');
    expect(decryptEncryptedTransferChunkEnvelope({ transferId: prepared.transferId, sequence: chunk.sequence,
      payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
      recipientSecretKeySeed: recipient.recipientSecretKeySeed })).toEqual(bytes);
    const settled = lifecycle.waitForFilesystemExportSettlement(prepared.transferId, scope);
    expect((await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, `${basePath}/complete`, 'POST',
      { destinationId: scope.destinationId, success: true, sizeBytes: bytes.length, manifestHash: prepared.manifestHash })).status).toBe(200);
    await expect(settled).resolves.toEqual({ success: true, sizeBytes: bytes.length, manifestHash: prepared.manifestHash });
    expect((await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, `${basePath}/chunks/0`, 'GET')).status).toBe(401);
    const cancelled = await prepareWorkspaceFileExport({ lifecycle, filesystemScope: scope,
      request: { workingDirectory: directory, path: 'binary.bin', asZip: false } });
    const cancellationEndpoint = cancelled.endpointCandidates[0];
    if (!cancellationEndpoint?.authorizationToken) throw new Error('Cancellation capability is unavailable');
    const cancellationSettlement = lifecycle.waitForFilesystemExportSettlement(cancelled.transferId, scope);
    const cancellationResponse = PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
      { ...request, authorizationToken: cancellationEndpoint.authorizationToken,
        path: `${new URL(cancellationEndpoint.url).pathname}/complete`, httpMethod: 'POST',
        body: { destinationId: scope.destinationId, success: false, error: 'Cancelled by recipient', errorCode: 'cancelled' } }));
    expect(cancellationResponse.status).toBe(200);
    await expect(cancellationSettlement).resolves.toMatchObject({ success: false, errorCode: 'cancelled' });
  } finally {
    await registration.dispose();
    await lifecycle.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it('writes and aborts the original prepared import through registered RPC phases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-prepared-import-rpc-seam-'));
  const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
  const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger() {} });
  const registration = registerMachineRpcHandlers({ rpcHandlerManager: manager, handlers: {
    spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Unavailable in transfer test' }),
    stopSession: async () => true, requestShutdown() {},
    preparedMachineTransfer: { request: lifecycle.requestPreparedTransfer },
  } });
  try {
    const scope = { rootPath: directory, requesterAccountId: 'account' };
    const bytes = Buffer.from([0, 255, 128, 10]);
    const prepared = await lifecycle.prepareImportSession({ t: 'session_file_upload_v1', workingDirectory: directory,
      path: 'received.bin', sizeBytes: bytes.length, overwrite: false }, scope);
    const chunk = createEncryptedTransferChunkEnvelope({ transferId: prepared.uploadId, sequence: 0,
      payload: bytes, recipientPublicKeyBase64: prepared.recipientPublicKeyBase64 });
    const basePath = new URL(prepared.endpointCandidates[0]!.url).pathname;
    const request = { t: 'prepared_machine_transfer_v1' as const };
    const written = PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
      { ...request, path: `${basePath}/chunks/0`, httpMethod: 'PUT', body: chunk }));
    expect(written.status).toBe(200);
    const settlement = lifecycle.waitForImportTransferSettlement(prepared.uploadId, scope);
    const finalized = PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
      { ...request, path: `${basePath}/finalize`, httpMethod: 'POST' }));
    expect(finalized.status).toBe(200);
    await expect(settlement).resolves.toMatchObject({ success: true, finalized: { path: 'received.bin' } });
    expect(await readFile(join(directory, 'received.bin'))).toEqual(bytes);
    const cancelled = await lifecycle.prepareImportSession({ t: 'session_file_upload_v1', workingDirectory: directory,
      path: 'cancelled.bin', sizeBytes: bytes.length, overwrite: false }, scope);
    const cancellationSettlement = lifecycle.waitForImportTransferSettlement(cancelled.uploadId, scope);
    const aborted = PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
      { ...request, path: `${new URL(cancelled.endpointCandidates[0]!.url).pathname}/abort`, httpMethod: 'POST' }));
    expect(aborted.status).toBe(200);
    await expect(cancellationSettlement).resolves.toMatchObject({ success: false, errorCode: 'cancelled' });
    await expect(readFile(join(directory, 'cancelled.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await registration.dispose(); await lifecycle.stop(); await rm(directory, { recursive: true, force: true });
  }
});
