import {
    SessionOwnerMetadataV1Schema,
    createPlainSessionOwnerMetadataEnvelopeV1,
    sealSessionOwnerMetadataEnvelopeV1,
    projectLegacySessionAccessCapabilitiesV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { isDataKeyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';

import { normalizeSessionAccessProjection } from './normalizeSessionAccessProjection';

import { readSessionLayout1OwnerMetadata, projectSessionLayout1OwnerMetadata } from './readSessionLayout1OwnerProjection';

const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
    v: 1,
    workspace: { path: '/private/worktree' },
});
const secret = new Uint8Array(32).fill(7);
const credentials = {
    token: 'token',
    secret: Buffer.from(secret).toString('base64url'),
};

describe('readSessionLayout1OwnerMetadata', () => {
    it('retains the same admitted plain owner facts only after validating fresh input', () => {
        const envelope = createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata);
        const params = { access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
            credentials: { token: 'plain-retention' }, accountMode: 'plain' as const, ownerMetadataEnvelope: envelope };
        const first = readSessionLayout1OwnerMetadata(params);
        expect(first.kind).toBe('owner');
        const previousProjection = first.kind === 'owner' ? first : null;
        expect(readSessionLayout1OwnerMetadata({ ...params, previousProjection,
            ownerMetadataEnvelope: structuredClone(envelope) })).toBe(first);
        expect(readSessionLayout1OwnerMetadata({ ...params, previousProjection,
            ownerMetadataEnvelope: { ...envelope, unexpected: true } })).toMatchObject({ kind: 'unavailable', reason: 'invalid_envelope' });
        expect(readSessionLayout1OwnerMetadata({ ...params, previousProjection,
            ownerMetadataEnvelope: { t: 'plain', v: { v: 1, workspace: { path: 9 } } } })).toMatchObject({ kind: 'unavailable', reason: 'invalid_envelope' });
        expect(readSessionLayout1OwnerMetadata({ ...params, previousProjection,
            ownerMetadataEnvelope: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { path: '/changed' } }) })).not.toBe(first);
    });
    it.each([null, undefined])('fails closed when an owner projection omits its required owner envelope (%s)', (ownerMetadataEnvelope) => {
        expect(readSessionLayout1OwnerMetadata({
            access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
            accountMode: 'e2ee',
            ownerMetadataEnvelope,
            credentials,
        })).toEqual({
            kind: 'unavailable',
            reason: 'invalid_envelope',
        });
    });

    it('opens plain owner options only from authoritative plain Account mode, not Session mode or key absence', () => {
        const plainOwner = createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({
            v: 1, workspace: { path: '/private' }, runtime: { modelOverrideV1: { v: 1, modelId: 'chosen', updatedAt: 10 } },
        }));
        const params = { access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
            credentials: { token: 'child-token' }, ownerMetadataEnvelope: plainOwner, composerOptionsInput: null };
        expect(readSessionLayout1OwnerMetadata({ ...params, accountMode: 'plain' })).toEqual({
            kind: 'composer', ownerMetadataView: null, composerOptionsInput: { modelOverrideV1: { v: 1, modelId: 'chosen', updatedAt: 10 } },
        });
        expect(readSessionLayout1OwnerMetadata({ ...params, accountMode: 'e2ee' })).toEqual({ kind: 'composer', ownerMetadataView: null, composerOptionsInput: null });
        expect(readSessionLayout1OwnerMetadata(params)).toEqual({ kind: 'composer', ownerMetadataView: null, composerOptionsInput: null });
    });
    it('keeps the complete owner view unavailable when a frame supplies only composer input', () => {
        const composerOptionsInput = { modelOverrideV1: { v: 1 as const, modelId: 'model-a', updatedAt: 10 } };
        const read = readSessionLayout1OwnerMetadata({
            access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
            ownerMetadataEnvelope: sealSessionOwnerMetadataEnvelopeV1({
                material: { type: 'legacy', secret }, ownerMetadata, randomBytes: (length) => new Uint8Array(length).fill(1),
            }),
            credentials: { token: 'child-token' },
            composerOptionsInput,
        });
        expect(projectSessionLayout1OwnerMetadata({ sharedMetadata: { v: 1 }, ownerMetadataRead: read }))
            .toEqual({ kind: 'composer', ownerMetadataView: null, composerOptionsInput });
    });

    it('extracts only composer input at the owner projection producer', () => {
        const catalog = {
            v: 1 as const, agentId: 'codex', updatedAt: 10, currentModelId: 'model-a',
            availableModels: [{ id: 'model-a', name: 'Model A' }],
        };
        const projection = projectSessionLayout1OwnerMetadata({
            sharedMetadata: { v: 1 },
            ownerMetadataRead: {
                kind: 'owner',
                ownerMetadataEnvelope: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
                ownerMetadata: SessionOwnerMetadataV1Schema.parse({
                    v: 1, workspace: { path: '/private/worktree' },
                    runtime: { sessionModelsV1: catalog },
                }),
            },
        });
        expect(projection).toMatchObject({
            kind: 'owner', composerOptionsInput: { sessionModelsV1: catalog },
        });
        expect(projection.kind === 'owner' && 'composerOptionsInput' in projection
            ? Object.keys(projection.composerOptionsInput as object) : []).toEqual(['sessionModelsV1']);
    });
    it.each(['plain', 'e2ee'] as const)('keeps Team-only recipients away from owner metadata in %s mode', (accountMode) => {
        const access = normalizeSessionAccessProjection({ effectiveAccess: {
            v: 1, level: 'edit',
            sources: [{ kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'edit' }),
        } });
        expect(readSessionLayout1OwnerMetadata({
            access,
            accountMode,
            ownerMetadataEnvelope: accountMode === 'plain'
                ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata)
                : sealSessionOwnerMetadataEnvelopeV1({
                    material: { type: 'legacy', secret }, ownerMetadata,
                    randomBytes: (length) => new Uint8Array(length).fill(1),
                }),
            credentials,
        })).toEqual({ kind: 'recipient' });
    });
    it.each(['plain', 'e2ee'] as const)('does not open owner metadata without explicit access authority in %s mode', (accountMode) => {
        expect(readSessionLayout1OwnerMetadata({
            access: null,
            accountMode,
            ownerMetadataEnvelope: accountMode === 'plain'
                ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata)
                : sealSessionOwnerMetadataEnvelopeV1({
                    material: { type: 'legacy', secret },
                    ownerMetadata,
                    randomBytes: (length) => new Uint8Array(length).fill(1),
                }),
            credentials,
        })).toMatchObject({ kind: 'unavailable', reason: 'access_unavailable' });
    });
    it('opens owner metadata using persisted Account mode independently from Session mode', () => {
        expect(readSessionLayout1OwnerMetadata({
            access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
            accountMode: 'plain',
            ownerMetadataEnvelope:
                createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
            credentials: { token: 'token' },
        })).toMatchObject({
            kind: 'owner',
            ownerMetadata,
        });

        expect(readSessionLayout1OwnerMetadata({
            access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
            accountMode: 'e2ee',
            ownerMetadataEnvelope: sealSessionOwnerMetadataEnvelopeV1({
                material: { type: 'legacy', secret },
                ownerMetadata,
                randomBytes: (length) => new Uint8Array(length).fill(1),
            }),
            credentials,
        })).toMatchObject({
            kind: 'owner',
            ownerMetadata,
        });
    });

    it('reuses only an unchanged encrypted envelope under the same credential authority', () => {
        const envelope = sealSessionOwnerMetadataEnvelopeV1({
            material: { type: 'legacy', secret }, ownerMetadata,
            randomBytes: length => new Uint8Array(length).fill(3),
        });
        const params = {
            access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
            accountMode: 'e2ee' as const, ownerMetadataEnvelope: envelope, credentials,
        };
        const first = readSessionLayout1OwnerMetadata(params);
        expect(first.kind).toBe('owner');
        expect(readSessionLayout1OwnerMetadata({ ...params, previousProjection: first.kind === 'owner' ? first : null,
            ownerMetadataEnvelope: { ...envelope },
        })).toBe(first);
        const retained = first.kind === 'owner' ? first : null;
        expect(readSessionLayout1OwnerMetadata({ ...params, previousProjection: retained, credentials: { token: 'keyless' } }))
            .toMatchObject({ kind: 'unavailable', reason: 'material_unavailable' });
        expect(readSessionLayout1OwnerMetadata({ ...params, previousProjection: retained, accountMode: 'plain' }))
            .toMatchObject({ kind: 'unavailable', reason: 'account_mode_mismatch' });
        expect(readSessionLayout1OwnerMetadata({ ...params, previousProjection: retained,
            ownerMetadataEnvelope: { ...envelope, unexpected: true },
        })).toMatchObject({ kind: 'unavailable', reason: 'invalid_envelope' });
        expect(readSessionLayout1OwnerMetadata({ ...params, previousProjection: retained,
            access: normalizeSessionAccessProjection({ effectiveAccess: {
                v: 1, level: 'view', sources: [{ kind: 'team', teamId: 'team', requiredByTeamPolicy: false }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
            } }),
        })).toEqual({ kind: 'recipient' });
        const changedCredentials = { ...credentials };
        const beforeMutation = readSessionLayout1OwnerMetadata({ ...params, credentials: changedCredentials });
        changedCredentials.secret = Buffer.from(new Uint8Array(32).fill(8)).toString('base64url');
        expect(readSessionLayout1OwnerMetadata({ ...params, credentials: changedCredentials,
            previousProjection: beforeMutation.kind === 'owner' ? beforeMutation : null,
        })).toMatchObject({ kind: 'unavailable', reason: 'invalid_ciphertext' });
    });

    it.each(['legacy', 'dataKey'] as const)('retains the full owner projection for recaptured %s credentials but not changed authority or mutated original material', kind => {
        const legacyCredentials = { ...credentials };
        const dataKeyCredentials = {
            token: credentials.token,
            encryption: { machineKey: encodeBase64(secret, 'base64'),
                publicKey: encodeBase64(new Uint8Array(32).fill(9), 'base64') },
        };
        const captured = kind === 'legacy' ? legacyCredentials : dataKeyCredentials;
        const recapture = () => isDataKeyAuthCredentials(captured)
            ? { ...captured, encryption: { ...captured.encryption } }
            : { ...captured };
        const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'e2ee', version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null });
        const params = {
            access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
            accountMode: 'e2ee' as const, accountCurrentness: currentness,
            ownerMetadataEnvelope: sealSessionOwnerMetadataEnvelopeV1({
                material: kind === 'legacy' ? { type: 'legacy', secret } : { type: 'dataKey', machineKey: secret },
                ownerMetadata, randomBytes: length => new Uint8Array(length).fill(3),
            }),
        };
        const project = (nextCredentials: AuthCredentials, previousProjection?: Extract<ReturnType<typeof readSessionLayout1OwnerMetadata>, { kind: 'owner' }>) =>
            projectSessionLayout1OwnerMetadata({ sharedMetadata: { v: 1 }, metadataVersion: 7,
                ownerMetadataRead: readSessionLayout1OwnerMetadata({ ...params,
                    credentials: nextCredentials, previousProjection }) });
        const first = project(captured);
        if (first.kind !== 'owner') throw new Error('Expected admitted owner projection');
        for (let refresh = 0; refresh < 10; refresh += 1) {
            const nextCredentials = recapture();
            expect(nextCredentials).not.toBe(captured);
            expect(first.isCurrentAuthority?.({ credentials: nextCredentials, accountCurrentness: { ...currentness } })).toBe(true);
            expect(project(nextCredentials, first)).toBe(first);
        }
        // Equal plaintext does not authorize reuse under a different credential.
        expect(project({ ...recapture(), token: 'replacement-token' }, first)).not.toBe(first);
        const changedCurrentness = { ...currentness, contentKeyFingerprint: 'replacement-account-key' };
        expect(first.isCurrentAuthority?.({ credentials: recapture(), accountCurrentness: changedCurrentness })).toBe(false);
        expect(readSessionLayout1OwnerMetadata({ ...params, credentials: recapture(),
            accountCurrentness: changedCurrentness, previousProjection: first })).not.toBe(first);
        const unchangedRecapture = recapture();
        if (kind === 'legacy') legacyCredentials.secret = encodeBase64(new Uint8Array(32).fill(8), 'base64url');
        else dataKeyCredentials.encryption.machineKey = encodeBase64(new Uint8Array(32).fill(8), 'base64');
        expect(first.isCurrentAuthority?.({ credentials: unchangedRecapture, accountCurrentness: currentness })).toBe(false);
        // The recaptured original bytes still open successfully, but mutated custody
        // must never revive the previous projection's witness.
        const reopened = project(unchangedRecapture, first);
        expect(reopened.kind).toBe('owner');
        expect(reopened).not.toBe(first);
        expect(project(captured, first)).toMatchObject({ kind: 'unavailable', reason: 'invalid_ciphertext' });
    });

    it.each([
        {
            accountMode: 'plain' as const,
            ownerMetadataEnvelope: sealSessionOwnerMetadataEnvelopeV1({
                material: { type: 'legacy' as const, secret },
                ownerMetadata,
                randomBytes: (length: number) =>
                    new Uint8Array(length).fill(1),
            }),
        },
        {
            accountMode: 'e2ee' as const,
            ownerMetadataEnvelope:
                createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
        },
    ])(
        'fails closed before disclosure when $accountMode Account mode disagrees with the envelope',
        ({ accountMode, ownerMetadataEnvelope }) => {
            expect(readSessionLayout1OwnerMetadata({
                access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
                accountMode,
                ownerMetadataEnvelope,
                credentials,
            })).toMatchObject({
                kind: 'unavailable',
                reason: 'account_mode_mismatch',
            });
        },
    );

    it('fails closed when E2EE material is unavailable', () => {
        const dataKeyCredentials = {
            token: 'token',
            encryption: {
                publicKey: encodeBase64(new Uint8Array(32).fill(8), 'base64'),
                machineKey: encodeBase64(secret, 'base64'),
            },
        } as const;
        expect(readSessionLayout1OwnerMetadata({
            access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
            accountMode: 'e2ee',
            ownerMetadataEnvelope: sealSessionOwnerMetadataEnvelopeV1({
                material: {
                    type: 'dataKey',
                    machineKey: new Uint8Array(32).fill(9),
                },
                ownerMetadata,
                randomBytes: (length) => new Uint8Array(length).fill(1),
            }),
            credentials: dataKeyCredentials,
        })).toMatchObject({
            kind: 'unavailable',
            reason: 'invalid_ciphertext',
        });
    });

    it('treats share presence as recipient authority before an overprojected owner envelope', () => {
        expect(readSessionLayout1OwnerMetadata({
            access: normalizeSessionAccessProjection({ share: { accessLevel: 'view', canApprovePermissions: false } }, { allowLegacy: true }),
            accountMode: 'e2ee',
            ownerMetadataEnvelope: sealSessionOwnerMetadataEnvelopeV1({
                material: { type: 'legacy', secret },
                ownerMetadata,
                randomBytes: (length) => new Uint8Array(length).fill(1),
            }),
            credentials,
        })).toEqual({ kind: 'recipient' });
    });
});
