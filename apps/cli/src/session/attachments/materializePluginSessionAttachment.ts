import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { SessionHandle } from '@happier-dev/plugin-sdk/sessions';
import type { RpcHandlerInvoker } from '@/api/rpc/types';
import { uploadBytesViaLocalRpc } from '@/transfers/rpc/uploadComposerMediaStageViaLocalRpc';

/** The existing Session upload target derives the workspace, filename and ignore rule. */
export async function materializePluginSessionAttachment(input: Readonly<{
  rpc: RpcHandlerInvoker;
  sessionId: string;
  request: Parameters<SessionHandle['materializeAttachment']>[0];
  signal: AbortSignal;
}>): ReturnType<SessionHandle['materializeAttachment']> {
  input.signal.throwIfAborted();
  if (!isAbsolute(input.request.sourcePath)) throw new PluginError({
    code: 'plugin_session_attachment_source_invalid',
    message: 'Attachment materialization requires a plugin-local absolute file path',
  });
  const bytes = await readFile(input.request.sourcePath, { signal: input.signal });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const uploaded = await uploadBytesViaLocalRpc({
    rpc: input.rpc,
    bytes,
    initRequest: {
      t: 'session_attachment_upload_v1',
      sessionId: input.sessionId,
      messageLocalId: input.request.messageLocalId,
      fileName: input.request.name,
      sizeBytes: bytes.byteLength,
    },
    signal: input.signal,
  });
  input.signal.throwIfAborted();
  if (uploaded.success && uploaded.response !== null && typeof uploaded.response === 'object'
    && 'path' in uploaded.response && typeof uploaded.response.path === 'string'
    && 'sizeBytes' in uploaded.response && uploaded.response.sizeBytes === bytes.byteLength
    && 'sha256' in uploaded.response && uploaded.response.sha256 === sha256) {
    return { path: uploaded.response.path, bytes };
  }
  throw new PluginError({
    code: 'plugin_session_attachment_unavailable',
    message: 'The hosted Session attachment transfer did not materialize the file',
    retryable: true,
  });
}
