import type { AttachmentPayloadV1 } from '@happier-dev/protocol/transfers/attachments/attachmentPayloadV1';
import type { RpcHandlerInvoker } from '@/api/rpc/types';
import type { projectRawIngressSessionAttachmentsV1 } from './projectRawIngressSessionAttachmentsV1';
import { projectRawIngressSessionAttachmentsV1 as projectIssuedAttachments } from './projectRawIngressSessionAttachmentsV1';
import { uploadBytesViaLocalRpc } from '@/transfers/rpc/uploadComposerMediaStageViaLocalRpc';
import { SessionAttachmentHandleV1Schema, type SessionAttachmentHandleV1 } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import { normalizeAttachmentRelativePathV1, sanitizeAttachmentFileName } from '@happier-dev/protocol/transfers/attachments/attachmentPathV1';
import { createHash, randomUUID } from 'node:crypto';

/** Materialize external bytes through the target Session's upload/issuance owner. */
export async function materializeSessionAttachments<TFile>(input: Readonly<{
  sessionId: string;
  messageLocalId: string;
  attachments: readonly AttachmentPayloadV1<TFile>[];
  readFile: (file: TFile) => Promise<Uint8Array>;
  rpc: RpcHandlerInvoker;
  resolveSessionAttachment: Parameters<typeof projectRawIngressSessionAttachmentsV1>[0]['resolveSessionAttachment'];
  signal: AbortSignal;
}>): Promise<ReturnType<typeof projectRawIngressSessionAttachmentsV1>> {
  const selected: SessionAttachmentHandleV1[] = [];
  const unavailable = () => new Error('session_attachment_materialization_unavailable');
  const relativePath = (value: string) => {
    const path = normalizeAttachmentRelativePathV1(value);
    if (!path) throw unavailable();
    return path;
  };
  const upload = async (bytes: Uint8Array, fields: Readonly<{
    fileName: string; attachmentId?: string; relativePath?: string; directoryEntries?: readonly string[];
  }>): Promise<SessionAttachmentHandleV1> => {
    input.signal.throwIfAborted();
    const result = await uploadBytesViaLocalRpc({ rpc: input.rpc, bytes,
      initRequest: { t: 'session_attachment_upload_v1', sessionId: input.sessionId,
        messageLocalId: input.messageLocalId, sizeBytes: bytes.byteLength, ...fields }, signal: input.signal });
    input.signal.throwIfAborted();
    if (!result.success || !result.response || typeof result.response !== 'object'
      || !('attachmentHandle' in result.response)) throw unavailable();
    const handle = SessionAttachmentHandleV1Schema.safeParse(result.response.attachmentHandle);
    if (!handle.success || handle.data.sessionId !== input.sessionId) throw unavailable();
    const issued = input.resolveSessionAttachment(handle.data);
    if (!issued || (fields.directoryEntries === undefined && (issued.sizeBytes !== bytes.byteLength
      || issued.sha256 !== createHash('sha256').update(bytes).digest('hex')))) throw unavailable();
    return handle.data;
  };
  for (const attachment of input.attachments) {
    input.signal.throwIfAborted();
    if (attachment.kind === 'file') {
      selected.push(await upload(await input.readFile(attachment.file), { fileName: attachment.name, attachmentId: attachment.id }));
      continue;
    }
    // Like the incumbent file target's random filename prefix, each preparation
    // allocates a fresh root so a partial/previous attempt cannot block retry.
    const root = relativePath(`${randomUUID()}/${sanitizeAttachmentFileName(attachment.name)}`);
    const entries = attachment.entries.map(entry => ({ ...entry, relativePath: relativePath(entry.relativePath) }));
    const directories = attachment.directories.map(relativePath);
    for (const entry of entries) {
      await upload(await input.readFile(entry.file), {
        fileName: entry.relativePath.split('/').at(-1)!, relativePath: `${root}/${entry.relativePath}`,
      });
    }
    selected.push(await upload(new Uint8Array(), { fileName: attachment.name, attachmentId: attachment.id,
      relativePath: root, directoryEntries: directories }));
  }
  return projectIssuedAttachments({ sessionId: input.sessionId, text: '',
    meta: { happierStructuredInputV1: { v: 1, sessionAttachments: selected } },
    resolveSessionAttachment: input.resolveSessionAttachment });
}
