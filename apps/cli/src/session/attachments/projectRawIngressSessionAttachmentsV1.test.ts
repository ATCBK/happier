import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { RawIngressStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { SessionAttachmentHandleV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { projectRawIngressSessionAttachmentsV1 } from './projectRawIngressSessionAttachmentsV1';
import { admitSessionStructuredInputV1 } from '../services/admitSessionStructuredInputV1';
import { createSessionClientTranscriptApi } from '@/api/session/client/transcript/sessionClientTranscriptApi';
import type { PersistedSessionUserMessageAdmission } from '@/api/session/client/transcript/sessionUserMessageAdmissionRejoin';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

function createTranscriptIntake(params: Readonly<{
  resolveSessionAttachment?: Parameters<typeof createSessionClientTranscriptApi>[0]['resolveSessionAttachment'];
  transformSessionInputBeforeCommit?: Parameters<typeof createSessionClientTranscriptApi>[0]['transformSessionInputBeforeCommit'];
  admitSessionUserMessage?: Parameters<typeof createSessionClientTranscriptApi>[0]['admitSessionUserMessage'];
  findPersistedSessionUserMessageAdmission?: Parameters<typeof createSessionClientTranscriptApi>[0]['findPersistedSessionUserMessageAdmission'];
  getMetadataSnapshot?: Parameters<typeof createSessionClientTranscriptApi>[0]['getMetadataSnapshot'];
}>) {
  return createSessionClientTranscriptApi({
    token: 'token', sessionId: 'session-1', outboundShapeLogger: { log: () => {} },
    getSocket: () => ({ connected: false, emit: () => {} }),
    getLatestTurnSnapshot: () => null, getActiveLocalTurnProgressAt: () => null,
    getSessionConnectionSupervisor: () => null, getMetadataSnapshot: () => null,
    updateAgentState: async () => {}, updateMetadata: async () => {},
    enqueueCommittedTranscriptMessage: async () => ({ persisted: true, delivered: false }),
    enqueueCommittedVoiceAgentTranscriptTurn: async () => ({ persisted: true, delivered: false }),
    usageObservationPublisher: { publish: async () => {} },
    buildOutboundSessionMessagePayload: content => ({ t: 'plain', v: content }),
    toolCallCanonicalNameByProviderAndId: new Map(), permissionToolCallRawInputByProviderAndId: new Map(),
    toolCallInputByProviderAndId: new Map(),
    admitSessionUserMessage: async ({ localId }) => ({ status: 'accepted', localId }),
    findPersistedSessionUserMessageAdmission: async () => null,
    getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }), ...params,
  });
}

describe('issued Session attachments at target intake', () => {
  it.each([false, true])('issues one directory descriptor preserving empty folders (empty root=%s)', async (empty) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-folder-intake-'));
    const rpc = new RpcHandlerManager({ scopePrefix: 'session-1', encryptionMode: 'plain' });
    const registration = registerSessionHandlers(rpc, directory, { sessionId: 'session-1' });
    const call = async (method: string, params: unknown) => await rpc.handleRequest({ method: `session-1:${method}`, params });
    try {
      let folderHandle: unknown;
      for (const [index, relativePath] of (empty ? [] : ['a.txt', 'nested/b.txt']).entries()) {
        const bytes = Buffer.from(index === 0 ? 'hello' : 'world!');
        const init = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
          t: 'session_attachment_upload_v1', sessionId: 'session-1', messageLocalId: 'folder-input',
          fileName: relativePath.split('/').at(-1), relativePath: `draft-1/project/${relativePath}`,
          sizeBytes: bytes.length,
          uploadLocation: 'workspace', workspaceRelativeDir: '.uploads', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
        }) as { success: boolean; uploadId: string; recipientPublicKeyBase64: string };
        expect(init.success).toBe(true);
        const chunk = createEncryptedTransferChunkEnvelope({ transferId: init.uploadId, sequence: 0,
          payload: bytes, recipientPublicKeyBase64: init.recipientPublicKeyBase64 });
        expect(await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 0,
          payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64 })).toEqual({ success: true });
        const finalized = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId }) as {
          success: boolean; attachmentHandle: unknown;
        };
        expect(finalized.success).toBe(true);
        folderHandle = finalized.attachmentHandle;
        expect(await readFile(join(directory, '.uploads/messages/folder-input/draft-1/project', relativePath))).toEqual(bytes);
      }
      const folderInit = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
        t: 'session_attachment_upload_v1', sessionId: 'session-1', messageLocalId: 'folder-input',
        fileName: 'project', relativePath: 'draft-1/project', directoryEntries: ['empty-child', 'nested/empty'], sizeBytes: 0,
        uploadLocation: 'workspace', workspaceRelativeDir: '.uploads', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
      }) as { success: boolean; uploadId: string };
      expect(folderInit.success).toBe(true);
      const folderResult = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: folderInit.uploadId }) as {
        success: boolean; attachmentHandle: unknown;
      };
      expect(folderResult.success).toBe(true);
      folderHandle = folderResult.attachmentHandle;
      const { stat } = await import('node:fs/promises');
      expect((await stat(join(directory, '.uploads/messages/folder-input/draft-1/project/empty-child'))).isDirectory()).toBe(true);
      expect((await stat(join(directory, '.uploads/messages/folder-input/draft-1/project/nested/empty'))).isDirectory()).toBe(true);
      const projected = projectRawIngressSessionAttachmentsV1({ sessionId: 'session-1', text: 'Read this folder',
        meta: { happierStructuredInputV1: { v: 1, sessionAttachments: [folderHandle] } },
        resolveSessionAttachment: registration.resolveSessionAttachment });
      expect(projected.meta).toMatchObject({ happier: { kind: 'attachments.v1', payload: { attachments: [{
        name: 'project', path: '.uploads/messages/folder-input/draft-1/project', mimeType: 'inode/directory', sizeBytes: empty ? 0 : 11,
      }] } } });
    } finally {
      await registration.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    { name: 'notes.txt', bytes: Buffer.from('real target attachment\n'), mimeType: null, text: '' },
    { name: 'pixel.png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'), mimeType: 'image/png', text: 'Read this' },
  ])('projects real uploaded $name bytes with text "$text" and refuses forged or other-Session handles', async ({ name, bytes, mimeType, text }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-issued-intake-'));
    const rpc = new RpcHandlerManager({ scopePrefix: 'session-1', encryptionMode: 'plain' });
    let intake: ReturnType<typeof createTranscriptIntake> | null = null;
    let received: unknown = null;
    const registration = registerSessionHandlers(rpc, directory, {
      sessionId: 'session-1',
      sessionRuntimeControls: {
        handleUserMessage: async () => { throw new Error('Issued attachments bypassed target admission'); },
        preparePendingMessageComposerAdmission: async request => {
          if (!intake) throw new Error('Missing target intake');
          return await intake.preparePendingMessageComposerAdmission(request);
        },
      },
      enqueueSessionUserMessage: async request => {
        if (!intake || !request.localId) throw new Error('Missing target intake');
        await intake.enqueueSessionUserMessage({ ...request, localId: request.localId });
      },
    });
    const call = async (method: string, params: unknown) => await rpc.handleRequest({ method: `session-1:${method}`, params });
    try {
      const init = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
        t: 'session_attachment_upload_v1', sessionId: 'session-1', messageLocalId: 'target-input',
        fileName: name, sizeBytes: bytes.length,
        uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
      }) as { success: boolean; uploadId: string; recipientPublicKeyBase64: string };
      expect(init.success).toBe(true);
      const encrypted = createEncryptedTransferChunkEnvelope({ transferId: init.uploadId, sequence: 0,
        payload: bytes, recipientPublicKeyBase64: init.recipientPublicKeyBase64 });
      expect(await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 0,
        payloadBase64: encrypted.payloadBase64, encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64 })).toEqual({ success: true });
      const finalized = await call(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId }) as {
        success: boolean; path: string; attachmentHandle: unknown;
      };
      expect(finalized.success).toBe(true);
      const handle = SessionAttachmentHandleV1Schema.parse(finalized.attachmentHandle);
      const structuredInput = RawIngressStructuredInputV1Schema.parse({ v: 1, sessionAttachments: [handle] });
      const projected = projectRawIngressSessionAttachmentsV1({
        sessionId: 'session-1', text, meta: { happierStructuredInputV1: structuredInput },
        resolveSessionAttachment: registration.resolveSessionAttachment,
      });
      const admitted = admitSessionStructuredInputV1({ ...projected,
        admissionPolicy: { allowedLocalImagePaths: projected.allowedLocalImagePaths },
      });
      expect(admitted.meta).toMatchObject({ happier: { kind: 'attachments.v1', payload: { attachments: [{
        path: finalized.path, name, sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), attachmentHandle: handle,
      }] } } });
      expect(admitted.structuredInput).not.toHaveProperty('sessionAttachments');
      if (mimeType) expect(admitted.structuredInput).toMatchObject({ imageInputs: [{
        path: finalized.path, mimeType, sha256: createHash('sha256').update(bytes).digest('hex'),
      }] });
      expect(projected.text).toBe(text);
      expect(await readFile(join(directory, finalized.path))).toEqual(bytes);
      const published = projected.meta.happier as { payload: { attachments: { attachmentHandle: { id: string } }[] } };
      published.payload.attachments[0].attachmentHandle.id = 'mutated-presentation';
      expect(registration.resolveSessionAttachment(handle)?.handle.id).toBe(handle.id);
      published.payload.attachments[0].attachmentHandle.id = handle.id;

      intake = createTranscriptIntake({ resolveSessionAttachment: registration.resolveSessionAttachment,
        admitSessionUserMessage: async request => {
          received = request;
          return { status: 'accepted', localId: request.localId };
        },
        // A contributed transform is an external plugin boundary. Its real strict
        // hook reader must see the issued projection before it can select slots.
        transformSessionInputBeforeCommit: payload => {
          expect(payload.meta).toMatchObject({ happier: { kind: 'attachments.v1' } });
          return { ...payload, text: `${payload.text}\n[configured hook]` };
        },
      });
      expect(await call(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1, {
        localId: 'target-input', text, structuredInput,
      })).toMatchObject({ ok: true, text: projected.text, sessionAttachmentMetadata: {
        key: 'happier', envelope: admitted.meta.happier,
      } });
      expect(await call(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, { localId: 'target-input',
        text, meta: { happierStructuredInputV1: structuredInput } })).toEqual({ ok: true });
      expect(received).toMatchObject({ meta: admitted.meta, text: `${projected.text}\n[configured hook]` });
      if (mimeType) {
        let queuedReceived: unknown = null;
        const queued = createTranscriptIntake({
          getMetadataSnapshot: () => createTestMetadata({ path: directory }),
          admitSessionUserMessage: async request => {
            queuedReceived = request;
            return { status: 'accepted', localId: request.localId };
          },
        });
        // The original Pending input carries a prepared descriptor, not a
        // volatile issued handle or a caller-supplied image allowlist.
        await queued.enqueueSessionUserMessage({ localId: 'queued-image', text: projected.text, meta: projected.meta });
        expect(queuedReceived).toMatchObject({ meta: { happierStructuredInputV1: { imageInputs: [{
          path: finalized.path, mimeType, sha256: createHash('sha256').update(bytes).digest('hex'),
        }] } } });
      }
      // The production transformer cannot succeed if its issued-store binding is missing.
      await expect(createTranscriptIntake({}).preparePendingMessageComposerAdmission({ localId: 'unbound',
        text: 'Read this', meta: { happierStructuredInputV1: structuredInput } }))
        .rejects.toMatchObject({ code: 'session_structured_input_session_attachment_invalid' });

      for (const [index, invalid] of [{ ...handle, sessionId: 'source-session' }, { ...handle, id: 'forged-upload' },
        { ...handle, sha256: 'a'.repeat(64) }, { ...handle, path: '/etc/passwd' }].entries()) {
        expect(() => projectRawIngressSessionAttachmentsV1({ sessionId: 'session-1', text: 'Read this',
          meta: { happierStructuredInputV1: { v: 1, sessionAttachments: [invalid] } },
          resolveSessionAttachment: registration.resolveSessionAttachment,
        })).toThrowError('session_structured_input_session_attachment_invalid');
        expect(await call(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, {
          localId: `invalid-${index}`, text: 'Read this',
          meta: { happierStructuredInputV1: { v: 1, sessionAttachments: [invalid] } },
        })).toMatchObject({ ok: false, errorCode: expect.stringMatching(/^session_structured_input_/) });
      }
      expect(() => admitSessionStructuredInputV1({ text: 'Read this', meta: {
        happierStructuredInputV1: structuredInput,
      } })).toThrowError('session_structured_input_session_attachment_preparation_required');

      const persisted = received as PersistedSessionUserMessageAdmission;
      await registration.dispose();
      expect(registration.resolveSessionAttachment(handle)).toBeNull();
      intake = createTranscriptIntake({ resolveSessionAttachment: registration.resolveSessionAttachment,
        findPersistedSessionUserMessageAdmission: async () => persisted,
        transformSessionInputBeforeCommit: () => { throw new Error('Preparation reran a configured hook'); },
      });
      expect(await call(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1, {
        localId: 'target-input', text, structuredInput,
      })).toMatchObject({ ok: true, text: projected.text, sessionAttachmentMetadata: { envelope: admitted.meta.happier } });
      // Reconstruct current intent; only the original writer may decide equality.
      expect(await call(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1, {
        localId: 'target-input', text: 'Changed instructions', structuredInput,
      })).toMatchObject({ ok: true, text: 'Changed instructions' });
      expect(await call(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1, {
        localId: 'target-input', text, structuredInput: { ...structuredInput,
          sessionAttachments: [{ ...handle, id: 'changed-selection' }],
        },
      })).toMatchObject({ ok: false });
    } finally {
      await registration.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
