import {
    SessionOwnerMetadataV1Schema,
    createPlainSessionOwnerMetadataEnvelopeV1,
    sealSessionOwnerMetadataEnvelopeV1,
    projectLegacySessionAccessCapabilitiesV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

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
