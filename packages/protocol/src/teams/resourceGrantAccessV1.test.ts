import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../crypto/base64.js';
import { computeContentPublicKeyFingerprint } from '../machines/identity/contentPublicKeyFingerprint.js';
import { ArtifactRecipientKeyEnvelopeInputV1Schema, ArtifactRecipientKeyEnvelopeCommitInputV1Schema } from '../artifacts/artifactAccessV1.js';
import { ResourceAccessGrantRowV1Schema, ResourceRecipientKeyEnvelopeInputV1Schema,
  ResourceRecipientKeyEnvelopeCommitInputV1Schema } from './resourceGrantAccessV1.js';

describe('shared resource grant and envelope contracts', () => {
  it('keeps Artifact provenance as a closed extension of the common content envelope', () => {
    const content = ResourceRecipientKeyEnvelopeInputV1Schema.parse({
      recipientAccountId: 'recipient', encryptedDataKey: encodeBase64(new Uint8Array(105)),
      recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(new Uint8Array(32).fill(1)),
    });
    const artifact = { ...content, encryptedProvenanceDataKey: content.encryptedDataKey };
    expect(ArtifactRecipientKeyEnvelopeInputV1Schema.parse(artifact)).toEqual(artifact);
    expect(ResourceRecipientKeyEnvelopeInputV1Schema.safeParse(artifact).success).toBe(false);
    for (const schema of [ResourceRecipientKeyEnvelopeInputV1Schema, ArtifactRecipientKeyEnvelopeInputV1Schema]) {
      expect(schema.safeParse({ ...content, accessLevel: 'admin' }).success).toBe(false);
    }
    const commit = { expectedDataEncryptionKey: content.encryptedDataKey, recipientKeyEnvelopes: [content] };
    expect(ResourceRecipientKeyEnvelopeCommitInputV1Schema.parse(commit)).toEqual(commit);
    expect(ArtifactRecipientKeyEnvelopeCommitInputV1Schema.parse({ ...commit, artifactId: 'artifact' })).toEqual({ ...commit, artifactId: 'artifact' });
    for (const [schema, input] of [
      [ResourceRecipientKeyEnvelopeCommitInputV1Schema, commit],
      [ArtifactRecipientKeyEnvelopeCommitInputV1Schema, { ...commit, artifactId: 'artifact' }],
    ] as const) {
      expect(schema.safeParse({ ...input, actorAccountId: 'other' }).success).toBe(false);
      expect(schema.safeParse({ ...input, recipientKeyEnvelopes: [content, content] }).success).toBe(false);
    }
  });

  it('keeps the shared principal and display objects recursively closed', () => {
    const grant = { principal: { kind: 'group', teamId: 'team', groupId: 'group' },
      accessLevel: 'view', createdByAccountId: 'owner', createdAt: 0, display: { name: null } };
    expect(ResourceAccessGrantRowV1Schema.parse(grant)).toEqual(grant);
    expect(ResourceAccessGrantRowV1Schema.safeParse({ ...grant, principal: { ...grant.principal, accountId: 'other' } }).success).toBe(false);
    expect(ResourceAccessGrantRowV1Schema.safeParse({ ...grant, display: { ...grant.display, accessLevel: 'admin' } }).success).toBe(false);
  });
});
