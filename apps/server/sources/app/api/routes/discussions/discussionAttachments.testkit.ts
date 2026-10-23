import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { db } from '@/storage/db';
import { registerDiscussionRoutes } from './registerDiscussionRoutes';
import * as privateFiles from '@/storage/blob/files';
import tweetnacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'privacy-kit';
import { sealAesGcmPayloadWebCrypto, openAesGcmPayloadWebCrypto, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto';
import { frameSessionDataKeyBundleV0, readSessionDataKeyBundleV0 } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { DiscussionMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';

function createAttachmentApp(actorAccountId: () => string) {
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: FastifyRequest) => {
        request.userId = actorAccountId();
        request.authAuthority = 'present_user';
        request.authTokenKind = 'account';
    });
    const keys = ['HAPPIER_FEATURE_SESSIONS__ENABLED', 'HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED'] as const;
    const saved = keys.map(key => process.env[key]);
    for (const key of keys) process.env[key] = '1';
    registerDiscussionRoutes(app);
    return { app, restoreEnvironment: () => keys.forEach((key, index) => {
        const value = saved[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }) };
}

/** Identical storage/HTTP contracts run against both admitted disposable providers. */
export function discussionAttachmentContracts(): void {
    it('atomically creates attachment-only history, rejoins without replacing bytes and reads only an exact current grant', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const bytes = Buffer.from('private Discussion attachment');
        const blobId = randomUUID();
        const input = { creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Files' } },
            participants: [{ kind: 'account', accountId: reader.id }], firstMessage: {
                localId: randomUUID(), mentionedAccountIds: [], attachments: [{ blobId, t: 'plain' }],
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'attachment', attachment: {
                    kind: 'file', id: blobId, name: 'evidence.txt', file: { blobId, mime: 'text/plain',
                        sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
                } }] } },
            } };
        const metadata = { operation: 'create', input, attachments: [{ blobId, t: 'plain', storedSizeBytes: bytes.length }] };
        let actorAccountId = owner.id;
        const { app, restoreEnvironment } = createAttachmentApp(() => actorAccountId);
        const upload = (payloadBytes = bytes, envelope: unknown = metadata) => app.inject({ method: 'POST', url: '/v1/discussions/upload',
            headers: { 'content-type': 'application/vnd.happier.discussion-upload-v1' },
            payload: Buffer.concat([Buffer.from(`${JSON.stringify(envelope)}\n`), payloadBytes]) });
        try {
            const rejected = await upload(bytes.subarray(0, bytes.length - 1));
            expect(rejected.statusCode).toBe(400);
            expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(0);
            const surplus = await upload(Buffer.concat([bytes, Buffer.from([1])]));
            expect(surplus.statusCode).toBe(400);
            expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(0);
            const multiple = structuredClone(metadata);
            const secondBlobId = randomUUID();
            const firstPart = multiple.input.firstMessage.content.v.parts[0]!;
            multiple.input.firstMessage.content.v.parts.push({ ...firstPart, attachment: { ...firstPart.attachment,
                id: secondBlobId, file: { ...firstPart.attachment.file, blobId: secondBlobId } } });
            multiple.input.firstMessage.attachments.push({ blobId: secondBlobId, t: 'plain' });
            multiple.attachments.push({ blobId: secondBlobId, t: 'plain', storedSizeBytes: bytes.length });
            expect((await upload(Buffer.concat([bytes, bytes.subarray(0, bytes.length - 1)]), multiple)).statusCode).toBe(400);
            expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(0);
            expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
            const tampered = await upload(Buffer.alloc(bytes.length));
            expect(tampered.statusCode).toBe(400);
            expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(0);
            const created = await upload();
            expect(created.statusCode).toBe(200);
            const result = created.json();
            const discussionId: string = result.discussion.id;
            const messageId: string = result.firstMessage.id;
            const retried = await upload();
            expect(retried.statusCode).toBe(200);
            expect(retried.json().firstMessage.id).toBe(messageId);
            const replayWithDifferentBytes = await upload(Buffer.alloc(bytes.length));
            expect(replayWithDifferentBytes.statusCode).toBe(200);
            const changedIntent = structuredClone(metadata);
            changedIntent.input.firstMessage.content.v.parts[0]!.attachment.name = 'changed-name.txt';
            expect((await upload(bytes, changedIntent)).statusCode).toBe(409);
            const inventoryReads = vi.spyOn(privateFiles, 'readPrivateFile');
            try {
                expect((await app.inject({ method: 'GET', url: '/v1/discussions' })).statusCode).toBe(200);
                expect((await app.inject({ method: 'GET', url: `/v1/discussions/${discussionId}/messages` })).statusCode).toBe(200);
                expect(inventoryReads).not.toHaveBeenCalled();
            } finally { inventoryReads.mockRestore(); }
            expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
            const folderId = randomUUID();
            const posted = await upload(Buffer.alloc(0), { operation: 'post', attachments: [], input: {
                discussionId, localId: randomUUID(), mentionedAccountIds: [], content: { t: 'plain', v: {
                    v: 1, parts: [{ t: 'attachment', attachment: { kind: 'folder', id: folderId,
                        name: 'empty-folder', entries: [], directories: ['nested/empty'] } }],
                } },
            } });
            expect(posted.statusCode).toBe(200);
            expect(posted.json().message.content.v.parts[0].attachment.directories).toEqual(['nested/empty']);
            expect(await db.discussionAttachment.count({ where: { messageId: posted.json().message.id } })).toBe(0);
            const textOnly = await app.inject({ method: 'POST', url: '/v1/discussions', payload: {
                creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Text neighbor' } },
                participants: [{ kind: 'account', accountId: reader.id }], firstMessage: { localId: randomUUID(), mentionedAccountIds: [],
                    content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Ordinary JSON send' }] } } },
            } });
            expect(textOnly.statusCode).toBe(200);
            actorAccountId = reader.id;
            const url = `/v1/discussions/${discussionId}/messages/${messageId}/attachments/${blobId}`;
            const read = await app.inject({ method: 'GET', url });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toEqual({ blobId, content: { t: 'plain', v: bytes.toString('base64') } });
            expect((await app.inject({ method: 'GET', url: url.replace(messageId, 'other-message') })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: url.replace(messageId, posted.json().message.id) })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: url.replace(discussionId, textOnly.json().discussion.id) })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: `${url}?throughSeq=0` })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: `${url}?throughSeq=-1` })).json()).toEqual({ error: 'discussion_invalid_content' });
            const readPrivateFile = privateFiles.readPrivateFile;
            // The private-storage boundary completes after access was captured; real DB admission must run again.
            const raced = vi.spyOn(privateFiles, 'readPrivateFile').mockImplementation(async key => {
                const value = await readPrivateFile(key);
                await db.discussionAccountGrant.deleteMany({ where: { discussionId, accountId: reader.id } });
                return value;
            });
            try { expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404); }
            finally { raced.mockRestore(); }
            actorAccountId = owner.id;
            expect((await app.inject({ method: 'POST', url: `/v1/discussions/${discussionId}/participants/invite`,
                payload: { participant: { kind: 'account', accountId: reader.id } } })).statusCode).toBe(200);
            const retained = await db.discussionAttachment.findUniqueOrThrow({ where: { blobId } });
            expect((await app.inject({ method: 'PUT', url: `/v1/discussions/${discussionId}/owner`,
                payload: { accountId: reader.id } })).statusCode).toBe(200);
            expect(await db.discussionAttachment.findUniqueOrThrow({ where: { blobId } })).toEqual(retained);
            expect(await db.discussionAttachment.count({ where: { message: { discussion: { ownerAccountId: owner.id } } } })).toBe(0);
            expect(await db.discussionAttachment.count({ where: { message: { discussion: { ownerAccountId: reader.id } } } })).toBe(1);
            // Retirement of the former owning Account leaves the transferred message and its private locator intact.
            await db.account.delete({ where: { id: owner.id } });
            actorAccountId = reader.id;
            expect((await app.inject({ method: 'GET', url })).json()).toEqual({ blobId, content: { t: 'plain', v: bytes.toString('base64') } });
            await db.discussion.update({ where: { id: discussionId }, data: { archivedAt: new Date() } });
            expect((await app.inject({ method: 'GET', url })).json()).toEqual({ blobId, content: { t: 'plain', v: bytes.toString('base64') } });
            await db.discussionAttachment.update({ where: { blobId }, data: { encryptionMode: 'e2ee' } });
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(400);
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
        } finally {
            await app.close();
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
            restoreEnvironment();
        }
    });

    it('stores only sealed bytes under the real Discussion key and refuses an invited reader without recipient material', async () => {
        const recipient = tweetnacl.box.keyPair();
        const binding = createSignedAccountContentBinding(recipient.publicKey);
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...binding } });
        const reader = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const dataKey = tweetnacl.randomBytes(32);
        const plaintext = new TextEncoder().encode('sealed private evidence');
        const sealed = frameSessionDataKeyBundleV0(await sealAesGcmPayloadWebCrypto(plaintext, dataKey));
        const blobId = randomUUID();
        const authored = DiscussionMessageContentV1Schema.parse({ v: 1, parts: [{ t: 'attachment', attachment: {
            kind: 'file', id: blobId, name: 'private.txt', file: { blobId, mime: 'text/plain', sizeBytes: plaintext.byteLength,
                sha256: createHash('sha256').update(plaintext).digest('hex') },
        } }] });
        const title = { v: 1 as const, title: 'Private files' };
        const first = { localId: randomUUID(), content: authored, mentionedAccountIds: [], attachments: [{ blobId, t: 'encrypted' as const }] };
        const participants = [{ kind: 'account' as const, accountId: reader.id }];
        const evidence = (canonicalIntent: string) => ({ kind: 'e2eeTag' as const,
            tag: deriveDiscussionMutationEqualityTagV1({ dataKey, canonicalIntent }) });
        const input = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: randomUUID(), participants,
            creationEqualityEvidenceV1: evidence(serializeDiscussionMutationEqualityIntentV1({ kind: 'create', title, participants, firstMessage: first })),
            titleContent: { t: 'encrypted', c: encodeBase64(await sealSessionDataKeyBundleV0(title, dataKey)) },
            dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: recipient.publicKey,
                randomBytes: tweetnacl.randomBytes })),
            expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(binding.contentPublicKey),
            firstMessage: { localId: first.localId, authoredContent: authored, mentionedAccountIds: [],
                requestEqualityEvidenceV1: evidence(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', ...first })),
                content: { t: 'encrypted', c: encodeBase64(await sealSessionDataKeyBundleV0(authored, dataKey)) } },
        });
        let actorAccountId = owner.id;
        const { app, restoreEnvironment } = createAttachmentApp(() => actorAccountId);
        try {
            const metadata = { operation: 'create', input, attachments: [{ blobId, t: 'encrypted', storedSizeBytes: sealed.byteLength }] };
            const created = await app.inject({ method: 'POST', url: '/v1/discussions/upload', headers: {
                'content-type': 'application/vnd.happier.discussion-upload-v1',
            }, payload: Buffer.concat([Buffer.from(`${JSON.stringify(metadata)}\n`), Buffer.from(sealed)]) });
            expect(created.statusCode).toBe(200);
            const result = created.json();
            const changedBindings = structuredClone(metadata);
            const otherBlobId = randomUUID();
            changedBindings.input.firstMessage.attachments![0]!.blobId = otherBlobId;
            changedBindings.attachments[0]!.blobId = otherBlobId;
            const conflict = await app.inject({ method: 'POST', url: '/v1/discussions/upload', headers: {
                'content-type': 'application/vnd.happier.discussion-upload-v1',
            }, payload: Buffer.concat([Buffer.from(`${JSON.stringify(changedBindings)}\n`), Buffer.from(sealed)]) });
            expect(conflict.statusCode).toBe(409);
            const url = `/v1/discussions/${result.discussion.id}/messages/${result.firstMessage.id}/attachments/${blobId}`;
            const read = await app.inject({ method: 'GET', url });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toEqual({ blobId, content: { t: 'encrypted', c: encodeBase64(sealed) } });
            const row = await db.discussionAttachment.findUniqueOrThrow({ where: { blobId } });
            expect(await privateFiles.readPrivateFile(row.storageKey)).toEqual(sealed);
            const bundle = readSessionDataKeyBundleV0(decodeBase64(read.json().content.c));
            if (bundle.status !== 'ready') throw new Error('Expected the canonical AES-GCM frame');
            expect(await openAesGcmPayloadWebCrypto(bundle.payload, dataKey)).toEqual(plaintext);
            actorAccountId = reader.id;
            expect((await app.inject({ method: 'GET', url })).json()).toEqual({ error: 'discussion_content_unavailable' });
        } finally {
            await app.close();
            await db.account.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
            restoreEnvironment();
        }
    });
}
