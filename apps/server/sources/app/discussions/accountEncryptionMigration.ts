import { isDeepStrictEqual } from 'node:util';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { DiscussionMessageContentV1StoredSchema, DiscussionTitleV1StoredSchema } from '@happier-dev/protocol/discussions/content';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import type { AccountEncryptionMigrateDiscussionsDirectiveV1, DiscussionAccountEncryptionInventoryV1 } from '@happier-dev/protocol/discussions/accountEncryptionMigration';
import { RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { deriveAccountRecipientEnvelopeReadinessFromRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { projectResourceRecipientEnvelope } from '@/app/teams/resourceGrantAccess';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Tx } from '@/storage/inTx';
import { resolveDiscussionAudienceInTx } from './access';
import { readDiscussionRecipientCensusInTx } from './accessService';
import { markDiscussionReadersChangedInTx } from './changes';

function readRows(tx: Tx, accountId: string) {
    return tx.discussion.findMany({ where: { ownerAccountId: accountId }, orderBy: { id: 'asc' },
        select: { id: true, encryptionMode: true, dataEncryptionKey: true, titleContent: true,
            messages: { orderBy: { id: 'asc' }, select: { id: true, content: true } },
            keyEnvelopes: { orderBy: { recipientAccountId: 'asc' }, select: { recipientAccountId: true,
                encryptedDataKey: true, recipientContentPublicKeyFingerprint: true } } } });
}

/** Owner-only inventory includes archived resources and every retained message. */
export async function readDiscussionAccountEncryptionInventoryInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication;
}>): Promise<DiscussionAccountEncryptionInventoryV1> {
    const items: DiscussionAccountEncryptionInventoryV1['items'] = [];
    for (const row of await readRows(tx, input.accountId)) {
        const census = await readDiscussionRecipientCensusInTx(tx, { actorAccountId: input.accountId,
            discussionId: row.id, authentication: input.authentication });
        if (!census.ok) throw new Error(census.error);
        items.push({ discussionId: row.id, dataEncryptionKey: privacyKit.encodeBase64(new Uint8Array(row.dataEncryptionKey)),
            titleContent: StrictSessionStoredMessageContentEnvelopeSchema.parse(row.titleContent),
            messages: row.messages.map(message => ({ id: message.id,
                content: StrictSessionStoredMessageContentEnvelopeSchema.parse(message.content) })), recipients: census.value });
    }
    return { items };
}

function matchesMode(content: unknown, mode: 'plain' | 'e2ee', title = false): boolean {
    const parsed = StrictSessionStoredMessageContentEnvelopeSchema.safeParse(content);
    if (!parsed.success || parsed.data.t !== (mode === 'plain' ? 'plain' : 'encrypted')) return false;
    return parsed.data.t === 'encrypted' || (title ? DiscussionTitleV1StoredSchema : DiscussionMessageContentV1StoredSchema).safeParse(parsed.data.v).success;
}
function keyMatchesMode(key: string, mode: 'plain' | 'e2ee'): boolean {
    if (mode === 'plain') return key === ARTIFACT_PLAIN_DATA_KEY_MARKER;
    try { return parseEncryptedDataKeyEnvelopeV1(privacyKit.decodeBase64(key)) !== null; }
    catch { return false; }
}

/** Read-only exact post-state matching; a replay cannot rewrite or republish. */
export async function matchDiscussionAccountEncryptionMigrationPostStateInTx(tx: Tx, input: Readonly<{
    accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateDiscussionsDirectiveV1;
}>): Promise<{ status: 'matched' | 'mismatch' }> {
    const rows = await readRows(tx, input.accountId);
    const items = new Map(input.directive?.items.map(item => [item.discussionId, item]));
    if (items.size !== (input.directive?.items.length ?? 0) || items.size !== rows.length) return { status: 'mismatch' };
    for (const row of rows) {
        const item = items.get(row.id);
        if (!item || row.encryptionMode !== input.toMode || !isDeepStrictEqual(row.titleContent, item.titleContent)
            || privacyKit.encodeBase64(new Uint8Array(row.dataEncryptionKey)) !== item.dataEncryptionKey) return { status: 'mismatch' };
        const messages = new Map(item.messages.map(message => [message.id, message]));
        if (messages.size !== item.messages.length || messages.size !== row.messages.length
            || row.messages.some(message => !isDeepStrictEqual(message.content, messages.get(message.id)?.content))) return { status: 'mismatch' };
        const envelopes = new Map(item.recipientKeyEnvelopes.map(envelope => [envelope.recipientAccountId, envelope]));
        if (envelopes.size !== row.keyEnvelopes.length || row.keyEnvelopes.some(envelope => {
            const expected = envelopes.get(envelope.recipientAccountId);
            return !expected || expected.encryptedDataKey !== privacyKit.encodeBase64(new Uint8Array(envelope.encryptedDataKey))
                || expected.recipientContentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint;
        })) return { status: 'mismatch' };
    }
    return { status: 'matched' };
}

/** Conversion participates in the incumbent Account transaction and source fence. */
export async function migrateDiscussionAccountEncryptionInTx(tx: Tx, input: Readonly<{
    accountId: string; fromMode: 'plain' | 'e2ee'; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateDiscussionsDirectiveV1;
}>): Promise<{ status: 'applied' | 'migration_incomplete' }> {
    const rows = await readRows(tx, input.accountId);
    const items = new Map(input.directive?.items.map(item => [item.discussionId, item]));
    if (items.size !== (input.directive?.items.length ?? 0) || items.size !== rows.length) return { status: 'migration_incomplete' };
    const audiences = new Map<string, readonly string[]>();
    // Validate the entire source and target census before changing any resource.
    for (const row of rows) {
        const item = items.get(row.id);
        if (!item || row.encryptionMode !== input.fromMode || !isDeepStrictEqual(row.titleContent, item.expectedTitleContent)
            || privacyKit.encodeBase64(new Uint8Array(row.dataEncryptionKey)) !== item.expectedDataEncryptionKey
            || !keyMatchesMode(item.expectedDataEncryptionKey, input.fromMode) || !keyMatchesMode(item.dataEncryptionKey, input.toMode)
            || !matchesMode(row.titleContent, input.fromMode, true) || !matchesMode(item.titleContent, input.toMode, true)) return { status: 'migration_incomplete' };
        const messages = new Map(item.messages.map(message => [message.id, message]));
        if (messages.size !== item.messages.length || messages.size !== row.messages.length
            || row.messages.some(message => {
                const replacement = messages.get(message.id);
                return !replacement || !isDeepStrictEqual(message.content, replacement.expectedContent)
                    || !matchesMode(message.content, input.fromMode) || !matchesMode(replacement.content, input.toMode);
            })) return { status: 'migration_incomplete' };
        const audience = await resolveDiscussionAudienceInTx(tx, row.id);
        audiences.set(row.id, audience);
        if (input.toMode === 'plain' && item.recipientKeyEnvelopes.length > 0) return { status: 'migration_incomplete' };
        const accounts = await tx.account.findMany({ where: { id: { in: audience.filter(id => id !== input.accountId) } }, select: RECIPIENT_READINESS_SELECT });
        const byAccountId = new Map(accounts.map(account => [account.id, account]));
        const readyRecipients = accounts.filter(account => deriveAccountRecipientEnvelopeReadinessFromRow(account).status === 'available');
        if (input.toMode === 'e2ee' && readyRecipients.length !== item.recipientKeyEnvelopes.length) return { status: 'migration_incomplete' };
        const recipientIds = new Set<string>();
        for (const envelope of item.recipientKeyEnvelopes) {
            const account = byAccountId.get(envelope.recipientAccountId);
            if (recipientIds.has(envelope.recipientAccountId) || envelope.recipientAccountId === input.accountId
                || !audience.includes(envelope.recipientAccountId) || !account
                || !projectResourceRecipientEnvelope(account, { ...envelope, encryptedDataKey: privacyKit.decodeBase64(envelope.encryptedDataKey) })) return { status: 'migration_incomplete' };
            recipientIds.add(envelope.recipientAccountId);
        }
    }
    for (const row of rows) {
        const item = items.get(row.id)!;
        await tx.discussion.update({ where: { id: row.id }, data: { encryptionMode: input.toMode,
            dataEncryptionKey: privacyKit.decodeBase64(item.dataEncryptionKey), titleContent: item.titleContent } });
        for (const message of item.messages) await tx.discussionMessage.update({ where: { id: message.id }, data: { content: message.content } });
        await tx.discussionKeyEnvelope.deleteMany({ where: { discussionId: row.id } });
        for (const envelope of item.recipientKeyEnvelopes) await tx.discussionKeyEnvelope.create({ data: { discussionId: row.id,
            ...envelope, encryptedDataKey: privacyKit.decodeBase64(envelope.encryptedDataKey) } });
        await markDiscussionReadersChangedInTx({ tx, discussionId: row.id, additionalAccountIds: audiences.get(row.id), accessChanged: true });
    }
    return { status: 'applied' };
}
