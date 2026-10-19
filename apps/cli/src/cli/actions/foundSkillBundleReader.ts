import { z } from 'zod/mini';
import { FoundSkillBundleV1Schema, FoundSkillDownloadRequestV1Schema, type FoundSkillBundleV1 } from '@happier-dev/protocol/prompts/library/skills/foundSkillTransferV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { readFoundSkillBundle, type FoundSkillReadOptions } from '@/prompts/skills/native/resolveFoundSkillDownloadSource';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';

export type FoundSkillMachineRpc = (machineId: string, method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;
const failure = z.strictObject({ success: z.literal(false), error: z.string(), code: z.optional(z.string()) });
const initResponse = z.union([failure, z.strictObject({ success: z.literal(true), downloadId: z.string().check(z.minLength(1)),
  chunkSizeBytes: z.number().check(z.int(), z.positive()), sizeBytes: z.number().check(z.int(), z.nonnegative()), name: z.string() })]);
const chunkResponse = z.union([failure, z.strictObject({ success: z.literal(true), payloadBase64: z.string(),
  encryptedDataKeyEnvelopeBase64: z.string(), isLast: z.boolean() })]);
const closeResponse = z.union([failure, z.strictObject({ success: z.literal(true) })]);
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/** The caller supplies its local identity only after binding it to the selected Home. */
export function createFoundSkillBundleReader(input: Omit<FoundSkillReadOptions, 'signal'> & Readonly<{
  machineId: string | null; machineRPC: FoundSkillMachineRpc;
}>): (machineId: string, path: string, signal?: AbortSignal) => Promise<FoundSkillBundleV1> {
  return async (machineId, path, signal) => {
    signal?.throwIfAborted();
    const request = FoundSkillDownloadRequestV1Schema.parse({ path });
    if (input.machineId !== null && machineId === input.machineId) {
      return await readFoundSkillBundle({ request, home: input.home, agents: input.agents, signal });
    }
    const recipient = createTransferRecipientKeyPair();
    const opened = initResponse.safeParse(await input.machineRPC(machineId, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
      { ...request, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 }, signal));
    if (!opened.success) return fail('invalid_transfer_response');
    if (!opened.data.success) return fail(opened.data.code ?? opened.data.error);
    const init = opened.data;
    let closed = false;
    try {
      signal?.throwIfAborted();
      const buffers: Buffer[] = [];
      let sizeBytes = 0;
      for (let index = 0;; index += 1) {
        signal?.throwIfAborted();
        const response = chunkResponse.safeParse(await input.machineRPC(machineId, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
          { downloadId: init.downloadId, index }, signal));
        if (!response.success) return fail('invalid_transfer_response');
        if (!response.data.success) return fail(response.data.code ?? response.data.error);
        let chunk: Buffer;
        try {
          chunk = decryptEncryptedTransferChunkEnvelope({ transferId: init.downloadId, sequence: index,
            payloadBase64: response.data.payloadBase64, encryptedDataKeyEnvelopeBase64: response.data.encryptedDataKeyEnvelopeBase64,
            recipientSecretKeySeed: recipient.recipientSecretKeySeed });
        } catch { return fail('invalid_transfer_response'); }
        sizeBytes += chunk.byteLength;
        // The source's declared length owns the transfer, including progress and completion.
        if (sizeBytes > init.sizeBytes || (!response.data.isLast && chunk.byteLength === 0)) return fail('invalid_transfer_response');
        buffers.push(chunk);
        if (response.data.isLast) break;
      }
      if (sizeBytes !== init.sizeBytes) return fail('invalid_transfer_response');
      signal?.throwIfAborted();
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(buffers, sizeBytes).toString('utf8')); }
      catch { return fail('invalid_found_skill_payload'); }
      const payload = FoundSkillBundleV1Schema.safeParse(body);
      if (!payload.success || !canonicalAbsolutePathsEqual(payload.data.path, request.path)) return fail('invalid_found_skill_payload');
      const finalized = closeResponse.safeParse(await input.machineRPC(machineId, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
        { downloadId: init.downloadId }, signal));
      if (!finalized.success) return fail('invalid_transfer_response');
      if (!finalized.data.success) return fail(finalized.data.code ?? finalized.data.error);
      closed = true;
      signal?.throwIfAborted();
      return payload.data;
    } catch (error) {
      if (signal?.aborted) return fail('cancelled');
      throw error;
    } finally {
      if (!closed) {
        // Cancellation cannot cancel cleanup of a session that init already acknowledged.
        await input.machineRPC(machineId, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
          { downloadId: init.downloadId }).catch(() => undefined);
      }
    }
  };
}
