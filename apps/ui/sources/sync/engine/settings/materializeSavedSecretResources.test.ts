import { describe, expect, it, vi } from 'vitest';
import {
    sealSavedSecretResourceStoredContentV1,
    type SavedSecretCatalogEntryV1,
    type SavedSecretResourceMaterialV1,
} from '@happier-dev/protocol';

import { materializeSavedSecretResources } from './materializeSavedSecretResources';

const entry = {
    ref: 'happier:shared-secret:v1:resource-a',
    source: 'shared_resource',
    relationship: 'recipient',
    name: 'Team key',
    kind: 'apiKey',
    encryptionMode: 'plain',
    owner: {
        kind: 'account',
        accountId: 'owner-a',
        name: 'Ada',
        firstName: 'Ada',
        lastName: null,
        username: null,
        avatarUrl: null,
    },
    accessSources: [{ kind: 'account' }],
    audience: null,
    ownerAccountId: 'owner-a',
    revision: 2,
    materialStatus: 'ready',
    capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
} as const satisfies SavedSecretCatalogEntryV1;

describe('materializeSavedSecretResources', () => {
    it('keeps healthy rows usable while excluding row-local corrupt records from the reference catalog', async () => {
        const healthy = {
            resourceId: 'resource-a',
            encryptionMode: 'plain',
            entry,
            storedContent: sealSavedSecretResourceStoredContentV1({
                resourceId: 'resource-a',
                mode: 'plain',
                content: { v: 1, name: 'Team key', kind: 'apiKey', value: 'plain-value' },
            }),
            recipientEnvelope: null,
        } satisfies SavedSecretResourceMaterialV1;
        const corruptOwner = {
            entry: {
                materialStatus: 'resource_corrupt',
                relationship: 'owner',
                repair: {
                    kind: 'delete_resource',
                    resourceId: 'retained-corrupt-row',
                    expectedRevision: 3,
                },
            },
        } satisfies SavedSecretResourceMaterialV1;
        const corruptRecipient = {
            entry: {
                materialStatus: 'resource_corrupt',
                relationship: 'recipient',
                repair: null,
            },
        } satisfies SavedSecretResourceMaterialV1;

        const result = await materializeSavedSecretResources({
            resources: [corruptOwner, healthy, corruptRecipient],
            decryptDataKeyEnvelope: async () => null,
        });

        expect(result.entries).toEqual([entry]);
        expect(result.corruptEntries).toEqual([corruptOwner.entry, corruptRecipient.entry]);
        expect(result.materializedSecrets.map((secret) => secret.id)).toEqual([entry.ref]);
    });

    it('opens authorized plain and E2EE resources into ephemeral Saved Secret rows', async () => {
        const dataKey = new Uint8Array(32).fill(7);
        const plain = {
            resourceId: 'resource-a', encryptionMode: 'plain', entry,
            storedContent: sealSavedSecretResourceStoredContentV1({
                resourceId: 'resource-a', mode: 'plain',
                content: { v: 1, name: 'Team key', kind: 'apiKey', value: 'plain-value' },
            }),
            recipientEnvelope: null,
        } satisfies SavedSecretResourceMaterialV1;
        const encrypted = {
            resourceId: 'resource-b', encryptionMode: 'e2ee',
            entry: {
                ...entry,
                ref: 'happier:shared-secret:v1:resource-b',
                name: 'Encrypted key',
                kind: 'token',
                encryptionMode: 'e2ee',
            },
            storedContent: sealSavedSecretResourceStoredContentV1({
                resourceId: 'resource-b', mode: 'e2ee', resourceDataKey: dataKey,
                content: { v: 1, name: 'Encrypted key', kind: 'token', value: 'encrypted-value' },
                randomBytes: (length) => new Uint8Array(length).fill(3),
            }),
            recipientEnvelope: { encryptedDataKey: 'opaque-envelope', recipientContentPublicKeyFingerprint: 'fingerprint' },
        } satisfies SavedSecretResourceMaterialV1;
        const decryptDataKeyEnvelope = vi.fn(async () => dataKey);

        const result = await materializeSavedSecretResources({ resources: [plain, encrypted], decryptDataKeyEnvelope });

        expect(result.materializedSecrets.map((secret) => ({ id: secret.id, value: secret.encryptedValue.value }))).toEqual([
            { id: entry.ref, value: 'plain-value' },
            { id: encrypted.entry.ref, value: 'encrypted-value' },
        ]);
        expect(decryptDataKeyEnvelope).toHaveBeenCalledWith('opaque-envelope');
    });

    it('fails one corrupt row closed without hiding independently usable resources', async () => {
        const plain = {
            resourceId: 'resource-b', encryptionMode: 'plain',
            entry: { ...entry, ref: 'happier:shared-secret:v1:resource-b', name: 'Usable key' },
            storedContent: sealSavedSecretResourceStoredContentV1({
                resourceId: 'resource-b', mode: 'plain',
                content: { v: 1, name: 'Usable key', kind: 'apiKey', value: 'usable-value' },
            }),
            recipientEnvelope: null,
        } satisfies SavedSecretResourceMaterialV1;
        const resource = {
            resourceId: 'resource-a', encryptionMode: 'e2ee',
            entry: { ...entry, encryptionMode: 'e2ee' },
            storedContent: { t: 'encrypted', c: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' },
            recipientEnvelope: { encryptedDataKey: 'opaque-envelope', recipientContentPublicKeyFingerprint: 'fingerprint' },
        } satisfies SavedSecretResourceMaterialV1;

        const result = await materializeSavedSecretResources({
            resources: [plain, resource],
            decryptDataKeyEnvelope: async () => null,
        });

        expect(result.materializedSecrets.map((secret) => secret.id)).toEqual([plain.entry.ref]);
        expect(result.entries.find((candidate) => candidate.ref === entry.ref)?.materialStatus)
            .toBe('temporarily_unavailable');
    });

    it('refuses material whose opened identity contradicts the catalog entry', async () => {
        // The content is authenticated, so this is not forgery: it is a catalog
        // row and a material snapshot that no longer describe the same secret.
        // Handing the picker that pair would let a Session be bound to a secret
        // the person did not choose, so the row fails closed like any other
        // unusable material instead of silently renaming itself.
        const mismatchedName = {
            resourceId: 'resource-a', encryptionMode: 'plain', entry,
            storedContent: sealSavedSecretResourceStoredContentV1({
                resourceId: 'resource-a', mode: 'plain',
                content: { v: 1, name: 'Other key', kind: 'apiKey', value: 'plain-value' },
            }),
            recipientEnvelope: null,
        } satisfies SavedSecretResourceMaterialV1;
        const mismatchedKind = {
            resourceId: 'resource-b', encryptionMode: 'plain',
            entry: { ...entry, ref: 'happier:shared-secret:v1:resource-b' },
            storedContent: sealSavedSecretResourceStoredContentV1({
                resourceId: 'resource-b', mode: 'plain',
                content: { v: 1, name: 'Team key', kind: 'token', value: 'plain-value' },
            }),
            recipientEnvelope: null,
        } satisfies SavedSecretResourceMaterialV1;
        const agreeing = {
            resourceId: 'resource-c', encryptionMode: 'plain',
            entry: { ...entry, ref: 'happier:shared-secret:v1:resource-c' },
            storedContent: sealSavedSecretResourceStoredContentV1({
                resourceId: 'resource-c', mode: 'plain',
                content: { v: 1, name: 'Team key', kind: 'apiKey', value: 'plain-value' },
            }),
            recipientEnvelope: null,
        } satisfies SavedSecretResourceMaterialV1;

        const result = await materializeSavedSecretResources({
            resources: [mismatchedName, mismatchedKind, agreeing],
            decryptDataKeyEnvelope: async () => null,
        });

        expect(result.materializedSecrets.map((secret) => secret.id)).toEqual([agreeing.entry.ref]);
        expect(result.entries.find((candidate) => candidate.ref === entry.ref)?.materialStatus)
            .toBe('temporarily_unavailable');
        expect(result.entries.find((candidate) => candidate.ref === mismatchedKind.entry.ref)?.capabilities.use)
            .toBe(false);
    });
});
