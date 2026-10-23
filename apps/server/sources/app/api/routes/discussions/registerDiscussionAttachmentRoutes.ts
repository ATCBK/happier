import { Readable } from 'node:stream';
import { readFile, rm } from 'node:fs/promises';
import { z } from 'zod/mini';
import { encodeBase64 } from 'privacy-kit';
import { DISCUSSION_HTTP_PATHS_V1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionAttachmentReadRequestV1Schema, DiscussionAttachmentReadResponseV1Schema } from '@happier-dev/protocol/discussions/attachments';
import type { DiscussionAttachmentUploadRequestV1 } from '@happier-dev/protocol/discussions/attachmentsUpload';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { DISCUSSION_UPLOAD_CONTENT_TYPE_V1, decodeDiscussionUploadMetadataV1, readBinaryUploadFrameV1 } from '@happier-dev/transfers';
import { TransferSessionStore, createTransferSessionLifecycle, readFiniteTransferConfig } from '@happier-dev/transfers/node';
import { inReadSnapshot } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { resolveDiscussionContextInTx } from '@/app/discussions/access';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { readDiscussionAttachment, prepareDiscussionAttachmentWrite, discardDiscussionAttachmentCandidate,
    cleanupRejectedDiscussionAttachmentUploads, type PreparedDiscussionAttachmentWrite } from '@/app/discussions/attachmentService';
import { stageDiscussionAttachmentAccountEncryptionConversion, cancelDiscussionAttachmentAccountEncryptionConversion } from '@/app/discussions/attachmentEncryptionConversion';
import { readSessionAccessAuthenticationFromRequest, type SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { createServerFeatureGatedRouteApp } from '@/app/features/catalog/serverFeatureGate';
import { requireRouteActionAuthority } from '@/app/api/utils/requireRouteActionAuthority';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import type { DiscussionFailureCode } from '@/app/discussions/serviceTypes';
import type { Fastify } from '../../types';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { log } from '@/utils/logging/log';

class DiscussionUploadRefusal extends Error {
    constructor(readonly code: DiscussionFailureCode) { super(code); }
}

/** Initial byte admission narrows custody; the ordinary message writer re-admits at commit. */
async function admitUpload(accountId: string, authentication: SessionAccessAuthentication, metadata: DiscussionAttachmentUploadRequestV1) {
    return inReadSnapshot(async tx => {
        if (metadata.operation === 'create') {
            const account = await tx.account.findUnique({ where: { id: accountId }, select: { encryptionMode: true, status: true } });
            if (!account || account.status !== 'active') throw new DiscussionUploadRefusal('discussion_post_denied');
            const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
            if (mode.status !== 'ready') throw new DiscussionUploadRefusal('discussion_content_unavailable');
            if ((mode.mode === 'plain' ? 'plain' : 'encrypted') !== metadata.input.firstMessage.content.t)
                throw new DiscussionUploadRefusal('discussion_encryption_mode_mismatch');
            return accountId;
        }
        const context = await resolveDiscussionContextInTx(tx, { discussionId: metadata.input.discussionId, accountId, authentication });
        if (!context) throw new DiscussionUploadRefusal('discussion_post_denied');
        if (!context.keyReadiness) throw new DiscussionUploadRefusal('discussion_content_unavailable');
        const discussion = await tx.discussion.findUnique({ where: { id: metadata.input.discussionId }, select: { archivedAt: true } });
        if (metadata.operation === 'encryption-conversion') {
            if (context.ownerAccountId !== accountId || metadata.attachments[0]?.t === (context.storageMode === 'plain' ? 'plain' : 'encrypted'))
                throw new DiscussionUploadRefusal('discussion_encryption_mode_mismatch');
        } else {
            const retry = await tx.discussionMessage.findUnique({ where: { discussionId_localId: {
                discussionId: metadata.input.discussionId, localId: metadata.input.localId,
            } }, select: { authorAccountId: true } });
            if (retry?.authorAccountId !== accountId) {
                if (context.access.level === 'view') throw new DiscussionUploadRefusal('discussion_post_denied');
                if (discussion?.archivedAt) throw new DiscussionUploadRefusal('discussion_archived');
            }
            if (metadata.input.content.t !== (context.storageMode === 'plain' ? 'plain' : 'encrypted'))
                throw new DiscussionUploadRefusal('discussion_encryption_mode_mismatch');
        }
        return context.ownerAccountId;
    });
}

/** Streamed bytes are a representation of create/post/reply, never an alternate append authority. */
export function registerDiscussionAttachmentRoutes(app: Fastify, statusForFailure: (error: DiscussionFailureCode) => number,
    errorHandler: (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => unknown): void {
    app.register(async scoped => {
        const routes = createServerFeatureGatedRouteApp(scoped, 'sessions.conversations', process.env, { error: 'discussions_unavailable' });
        const rateLimit = resolveApiHotEndpointRateLimit(process.env, 'session.discussions');
        const config = readFiniteTransferConfig(process.env);
        const store = new TransferSessionStore({ ttlMs: config.ttlMs, expiryTrigger: 'self' });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: config.chunkSizeBytes });
        scoped.addHook('onClose', async () => { await store.dispose(); });
        scoped.addContentTypeParser(DISCUSSION_UPLOAD_CONTENT_TYPE_V1, (_request, payload, done) => done(null, payload));
        routes.get(DISCUSSION_HTTP_PATHS_V1.attachment, { preHandler: scoped.authenticate, config: { allowApiToken: true, rateLimit }, errorHandler,
            schema: { params: DiscussionAttachmentReadRequestV1Schema, querystring: z.strictObject({ throughSeq: z.optional(z.coerce.number().check(z.int(), z.nonnegative())) }),
                response: { 200: DiscussionAttachmentReadResponseV1Schema } },
        }, async (request, reply) => {
            const result = await readDiscussionAttachment({ ...request.params, ...request.query, actorAccountId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request) });
            return result.ok ? reply.send(result.value) : reply.code(statusForFailure(result.error)).send({ error: result.error });
        });
        routes.post(DISCUSSION_HTTP_PATHS_V1.upload, { preHandler: scoped.authenticate, config: { rateLimit }, errorHandler }, async (request, reply) => {
            const prepared: PreparedDiscussionAttachmentWrite[] = [];
            const uploadIds: string[] = [];
            let stageId: string | null = null;
            let conversionResult: unknown;
            let response: Readonly<{ statusCode: number; body: unknown }> | undefined;
            let canceled = request.raw.aborted;
            const cancelStage = async () => {
                if (!stageId) return;
                await cancelDiscussionAttachmentAccountEncryptionConversion({ accountId: request.userId, uploadId: stageId });
            };
            const onAbort = () => { canceled = true; };
            const onResponseClose = () => {
                if (reply.raw.writableFinished) return;
                canceled = true;
                void cancelStage().catch(() => log({ module: 'api', level: 'warn' }, 'Discussion conversion retained private cleanup custody'));
            };
            request.raw.once('aborted', onAbort);
            reply.raw.once('close', onResponseClose);
            reply.raw.once('finish', () => reply.raw.off('close', onResponseClose));
            const authentication = readSessionAccessAuthenticationFromRequest(request);
            try {
                if (!(request.body instanceof Readable)) throw new DiscussionUploadRefusal('discussion_invalid_content');
                let ownerAccountId = request.userId;
                let destination: DiscussionAttachmentUploadRequestV1 | undefined;
                const metadata = await readBinaryUploadFrameV1(request.body, {
                    metadataMaxBytes: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
                    decodeMetadata: decodeDiscussionUploadMetadataV1,
                    onMetadata: async value => {
                        destination = value;
                        const actionId = value.operation === 'create' ? 'discussion.create'
                            : value.operation === 'reply' ? 'discussion.reply' : 'discussion.post';
                        // The shared authority guard sees the real operation input after framing admission.
                        const authority = await requireRouteActionAuthority(actionId)({ ...request, body: value.input }, reply);
                        if (reply.sent || authority !== undefined) throw new DiscussionUploadRefusal('discussion_post_denied');
                        ownerAccountId = await admitUpload(request.userId, authentication, value);
                        await cleanupRejectedDiscussionAttachmentUploads(ownerAccountId);
                        return value.attachments;
                    },
                    onSegment: async (index, chunks) => {
                        const target = destination;
                        const segment = target?.attachments[index];
                        if (!target || !segment || canceled) throw new DiscussionUploadRefusal('discussion_invalid_content');
                        const opened = await lifecycle.openUploadTransferSession({ target: {
                            destPath: ownerAccountId, destDisplayPath: segment.blobId, overwrite: false,
                            expectedSizeBytes: segment.storedSizeBytes,
                            finalizeUpload: async ({ tempPath, sizeBytes }) => {
                                try {
                                    if (canceled) throw new Error('Discussion upload canceled');
                                    const bytes = await readFile(tempPath);
                                    const content = segment.t === 'plain' ? { t: 'plain' as const, v: encodeBase64(bytes) }
                                        : { t: 'encrypted' as const, c: encodeBase64(bytes) };
                                    if (target.operation === 'encryption-conversion') {
                                        const stage = await stageDiscussionAttachmentAccountEncryptionConversion({ accountId: request.userId,
                                            ...target.input, content });
                                        stageId = stage.uploadId;
                                        if (canceled) { await cancelStage(); throw new Error('Discussion upload canceled'); }
                                        return { success: true, path: segment.blobId, sizeBytes, result: stage };
                                    }
                                    const candidate = await prepareDiscussionAttachmentWrite({ accountId: ownerAccountId, blobId: segment.blobId, content });
                                    // Preparation retains only lengths/digests after persisting this file.
                                    prepared.push(candidate);
                                    return { success: true, path: segment.blobId, sizeBytes };
                                } finally { await rm(tempPath, { force: true }); }
                            },
                        } });
                        uploadIds.push(opened.uploadId);
                        let chunkIndex = 0;
                        for await (const chunk of chunks) for (let offset = 0; offset < chunk.byteLength; offset += config.chunkSizeBytes) {
                            if (canceled) throw new Error('Discussion upload canceled');
                            const written = await lifecycle.writeUploadTransferChunk({ uploadId: opened.uploadId, index: chunkIndex++,
                                contentBase64: encodeBase64(chunk.subarray(offset, offset + config.chunkSizeBytes)) });
                            if (!written.success) throw new Error('Discussion upload chunk refused');
                        }
                        const finalized = await lifecycle.finalizeUploadTransferSession({ uploadId: opened.uploadId });
                        if (!finalized.success) throw new Error('Discussion upload incomplete');
                        if (target.operation === 'encryption-conversion') conversionResult = finalized.finalized.result;
                    },
                });
                if (canceled) throw new DiscussionUploadRefusal('discussion_invalid_content');
                if (metadata.operation === 'encryption-conversion') response = { statusCode: 200, body: conversionResult };
                else {
                    const result = metadata.operation === 'create'
                        ? await createDiscussion({ actorAccountId: request.userId, authentication, request: metadata.input, preparedAttachments: prepared })
                        : await (() => {
                            const { discussionId, ...postRequest } = metadata.input;
                            return postDiscussionMessage({ actorAccountId: request.userId, authentication, discussionId,
                                request: postRequest, preparedAttachments: prepared });
                        })();
                    response = result.ok ? { statusCode: 200, body: result.value }
                        : { statusCode: statusForFailure(result.error), body: { error: result.error } };
                }
            } catch (error) {
                await cancelStage();
                if (reply.sent) return;
                const code = error instanceof DiscussionUploadRefusal ? error.code : 'discussion_invalid_content';
                response = { statusCode: statusForFailure(code), body: { error: code } };
            } finally {
                request.raw.off('aborted', onAbort);
                reply.raw.off('close', onResponseClose);
                for (const uploadId of uploadIds) await lifecycle.abortUploadTransferSession({ uploadId });
                for (const candidate of prepared) {
                    try { await discardDiscussionAttachmentCandidate(candidate); }
                    catch {
                        // The shared rejected custody row retains the exact locator for the next upload/erasure.
                        log({ module: 'api', level: 'warn' }, 'Discussion upload retained private cleanup custody');
                    }
                }
            }
            if (response) return reply.code(response.statusCode).send(response.body);
        });
        routes.delete(DISCUSSION_HTTP_PATHS_V1.attachmentUpload, { preHandler: scoped.authenticate, errorHandler,
            schema: { params: z.strictObject({ uploadId: z.string().check(z.uuid()) }) },
        }, async (request, reply) => {
            await cancelDiscussionAttachmentAccountEncryptionConversion({ accountId: request.userId, uploadId: request.params.uploadId });
            return reply.send({ success: true });
        });
    });
}
