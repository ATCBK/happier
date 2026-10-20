import { describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DiscussionAccountEncryptionInventoryV1Schema } from '@happier-dev/protocol/discussions/accountEncryptionMigration';
import { Encryption } from '@/sync/encryption/encryption';
import { buildAccountEncryptionDiscussionsDirective } from './buildAccountEncryptionDiscussionsDirective';

describe('Account Discussion conversion client', () => {
    it('uses the resource DEK codec to preserve title and every message in both directions', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const scope = { scope: { serverId: 'home', accountId: 'owner' }, isCurrent: () => true };
        const titleContent = { t: 'plain' as const, v: { v: 1, title: 'Private title' } };
        const content = { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: 'Private message' }] } };
        const inventory = DiscussionAccountEncryptionInventoryV1Schema.parse({ items: [{ discussionId: 'discussion', titleContent,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, messages: [{ id: 'message', content }], recipients: {
                discussionId: 'discussion', ownerAccountId: 'owner', encryptionMode: 'plain', access: 'owner',
                dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
            } }] });
        const encrypted = await buildAccountEncryptionDiscussionsDirective({ inventory, fromMode: 'plain', toMode: 'e2ee',
            sourceEncryption: null, targetEncryption: encryption, scope });
        const converted = encrypted.items[0]!;
        expect(converted.titleContent.t).toBe('encrypted');
        const targetBytes = JSON.stringify({ title: converted.titleContent, messages: converted.messages.map(message => message.content) });
        expect(targetBytes).not.toContain('Private title');
        expect(targetBytes).not.toContain('Private message');
        const reverseInventory = DiscussionAccountEncryptionInventoryV1Schema.parse({ items: [{ ...inventory.items[0],
            titleContent: converted.titleContent, dataEncryptionKey: converted.dataEncryptionKey,
            messages: converted.messages.map(message => ({ id: message.id, content: message.content })),
            recipients: { ...inventory.items[0]!.recipients, encryptionMode: 'e2ee',
                dataEncryptionKey: converted.dataEncryptionKey, callerDataEncryptionKey: converted.dataEncryptionKey },
        }] });
        const plain = await buildAccountEncryptionDiscussionsDirective({ inventory: reverseInventory, fromMode: 'e2ee', toMode: 'plain',
            sourceEncryption: encryption, targetEncryption: null, scope });
        expect(plain.items[0]).toMatchObject({ dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, titleContent,
            messages: [{ id: 'message', content }], recipientKeyEnvelopes: [] });
        await expect(buildAccountEncryptionDiscussionsDirective({ inventory: reverseInventory, fromMode: 'e2ee', toMode: 'plain',
            sourceEncryption: null, targetEncryption: null, scope })).rejects.toThrow('key unavailable');
    });
});
