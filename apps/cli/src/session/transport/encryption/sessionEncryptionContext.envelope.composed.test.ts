import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { deriveAccountMachineKeyFromRecoverySecret, projectSessionAccessCapabilitiesV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@/api/encryption';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import {
  decryptSessionPayload,
  decryptStoredSessionPayload,
  encryptSessionPayload,
  readSessionPresentationContent,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionTransportContextFromMaterial,
  tryDecryptSessionPresentationMetadataView,
} from './sessionEncryptionContext';
import {
  openSessionStoredContent,
  sealSessionStoredContent,
} from './sessionStoredContentCodec';

// Load the other runtime's fixture through the test loader without adding UI
// source to the CLI compiler's root. Crypto and fixture contents remain real.
const { UI_CRYPTO_GOLDEN_VECTORS } = await vi.importActual<{
  UI_CRYPTO_GOLDEN_VECTORS: { aesGcmJson: { keyHex: string; values: { encryptedPayloadHex: string }[] } };
}>('../../../../../ui/sources/sync/encryption/nativeCryptoWorker/cryptoGoldenVectors');

const secret = new Uint8Array(32).fill(7);
const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
const publicKey = nacl.box.keyPair.fromSecretKey(machineKey).publicKey;
const credentials = [
  { token: 'test', encryption: { type: 'legacy', secret } },
  { token: 'test', encryption: { type: 'dataKey', machineKey, publicKey } },
] as const;
const dek = new Uint8Array(32).fill(19);
const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
  dataKey: dek, recipientPublicKey: publicKey, randomBytes: (length) => new Uint8Array(length).fill(11),
}));

describe.each(credentials)('Session envelope with $encryption.type credentials', (credential) => {
  it('opens the same current envelope and selects its data-key cipher independently of credential storage', () => {
    expect(openSessionDataEncryptionKey({ credential, encryptedDataEncryptionKeyBase64: dataEncryptionKey })).toEqual(dek);
    const ctx = resolveSessionEncryptionContextFromCredentials(credential, { dataEncryptionKey });
    expect(ctx).toEqual({ encryptionKey: dek, encryptionVariant: 'dataKey' });
    if (!ctx) throw new Error('missing context');
    const ciphertextBase64 = encryptSessionPayload({ ctx: { encryptionKey: dek, encryptionVariant: 'dataKey' }, payload: { text: 'shared content' } });
    expect(decryptSessionPayload({ ctx, ciphertextBase64 })).toEqual({ text: 'shared content' });
  });

  it.each(['', ' ', 'not-base64', 123, {}, 'AAAA', `!${dataEncryptionKey}`])('never falls back for a present invalid envelope: %j', (invalid) => {
    expect(resolveSessionEncryptionContextFromCredentials(credential, { dataEncryptionKey: invalid })).toBeNull();
  });

  it('preserves the credential-specific absent-envelope historical reader', () => {
    expect(openSessionDataEncryptionKey({ credential, encryptedDataEncryptionKeyBase64: null })).toBeNull();
    expect(resolveSessionEncryptionContextFromCredentials(credential, { dataEncryptionKey: null })).toEqual({
      encryptionKey: credential.encryption.type === 'legacy' ? secret : machineKey,
      encryptionVariant: credential.encryption.type,
    });
  });

  it('does not give an absent-envelope recipient the historical owner reader', () => {
    const rawSession = { dataEncryptionKey: null, share: { accessLevel: 'view', canApprovePermissions: false } };
    expect(resolveSessionEncryptionContextFromCredentials(credential, rawSession)).toBeNull();
  });

  it('uses current effective access before the released share-null owner inference', () => {
    const rawSession = {
      dataEncryptionKey: null,
      share: null,
      effectiveAccess: {
        v: 1,
        level: 'view',
        sources: [{ kind: 'team', teamId: 'team', requiredByTeamPolicy: false }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: 'view', canApprovePermissions: false }] }),
      },
    };
    expect(resolveSessionEncryptionContextFromCredentials(credential, rawSession)).toBeNull();
    expect(resolveSessionEncryptionContextFromCredentials(credential, { ...rawSession, effectiveAccess: { v: 1 } })).toBeNull();
    expect(resolveSessionEncryptionContextFromCredentials(credential, { ...rawSession, effectiveAccess: null })).toBeNull();
  });

  it('does not give a layout-one row with an omitted legacy role marker the historical owner reader', () => {
    expect(resolveSessionEncryptionContextFromCredentials(credential, {
      dataEncryptionKey: null,
      metadataLayoutVersion: 1,
    })).toBeNull();
  });

  it('opens the shared UI/native AES golden ciphertext after unwrapping its Session key', () => {
    const vector = UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson;
    const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: new Uint8Array(Buffer.from(vector.keyHex, 'hex')),
      recipientPublicKey: publicKey,
      randomBytes: (length) => new Uint8Array(length).fill(23),
    }));
    const ctx = resolveSessionEncryptionContextFromCredentials(credential, { dataEncryptionKey: envelope });
    expect(ctx?.encryptionVariant).toBe('dataKey');
    if (!ctx) throw new Error('missing context');
    expect(decryptSessionPayload({
      ctx,
      ciphertextBase64: Buffer.from(vector.values[0].encryptedPayloadHex, 'hex').toString('base64'),
    })).toEqual({ ok: true, count: 2, nested: ['a', null] });
  });
});

it('fails closed with wrong or keyless material', () => {
  for (const credential of [
    { token: 'test', encryption: null },
    { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(99) } },
    { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(31) } },
    { token: 'test', encryption: { type: 'dataKey', machineKey: new Uint8Array(32).fill(99), publicKey } },
    { token: 'test', encryption: { type: 'dataKey', machineKey: new Uint8Array(31), publicKey } },
  ] as const) {
    expect(resolveSessionEncryptionContextFromCredentials(credential, { dataEncryptionKey })).toBeNull();
  }
});

describe('explicit Session transport material', () => {
  it('opens ordinary shared source content without Account credentials or owner-private metadata', () => {
    const metadata = { v: 1, summary: { text: 'Shared source', updatedAt: 10 } };
    const ciphertext = encryptSessionPayload({
      ctx: { encryptionKey: dek, encryptionVariant: 'dataKey' },
      payload: metadata,
    });
    const materialKey = dek.slice();
    const result = resolveSessionTransportContextFromMaterial({
      rawSession: { encryptionMode: 'e2ee' },
      material: { mode: 'e2ee', dataEncryptionKey: materialKey },
    });
    expect(result).toEqual({ ok: true, mode: 'e2ee', ctx: { encryptionKey: dek, encryptionVariant: 'dataKey' } });
    if (!result.ok) throw new Error('Expected explicit crypto context');
    // The receiving runtime owns the context lifetime, independently of the
    // caller's transport buffer. No global cache or Account material is needed.
    materialKey.fill(0);
    expect(decryptStoredSessionPayload({ ...result, value: ciphertext })).toEqual(metadata);
    expect(result).not.toHaveProperty('accountEncryptionCurrentness');
  });

  it('keeps Plain source hydration keyless', () => {
    const result = resolveSessionTransportContextFromMaterial({
      rawSession: { encryptionMode: 'plain' },
      material: { mode: 'plain' },
    });
    expect(result).toEqual({ ok: true, mode: 'plain', ctx: null });
    if (!result.ok) throw new Error('Expected Plain context');
    expect(decryptStoredSessionPayload({ ...result, value: '{"v":1}' })).toEqual({ v: 1 });
  });

  it.each([0, 31, 33])('rejects a %s-byte source key', (length) => {
    expect(resolveSessionTransportContextFromMaterial({
      rawSession: { encryptionMode: 'e2ee' },
      material: { mode: 'e2ee', dataEncryptionKey: new Uint8Array(length) },
    })).toEqual({ ok: false, code: 'encryption_material_unavailable' });
  });

  it.each([
    { rawSession: { encryptionMode: 'plain' }, material: { mode: 'e2ee', dataEncryptionKey: dek } },
    { rawSession: { encryptionMode: 'e2ee' }, material: { mode: 'plain' } },
    { rawSession: { encryptionMode: 'plain' }, material: { mode: 'plain', dataEncryptionKey: dek } },
    { rawSession: { encryptionMode: 'unsupported' }, material: { mode: 'e2ee', dataEncryptionKey: dek } },
  ] as const)('rejects disagreement between row and supplied material', (input) => {
    expect(resolveSessionTransportContextFromMaterial(input))
      .toEqual({ ok: false, code: 'encryption_material_unavailable' });
  });
});

describe('canonical Session stored-content envelope codec', () => {
  const plain = { mode: 'plain' as const, ctx: null };
  const e2ee = {
    mode: 'e2ee' as const,
    ctx: { encryptionKey: dek, encryptionVariant: 'dataKey' as const },
  };
  const payload = { v: 1, text: 'shared outer envelope' };

  it.each([plain, e2ee])('seals and opens the canonical $mode envelope', (context) => {
    const content = sealSessionStoredContent({ ...context, payload });
    expect(content.t).toBe(context.mode === 'plain' ? 'plain' : 'encrypted');
    expect(openSessionStoredContent({ ...context, content })).toEqual(payload);
  });

  it('distinguishes a mode mismatch from unavailable encrypted content', () => {
    expect(() => openSessionStoredContent({
      ...e2ee,
      content: { t: 'plain', v: payload },
    })).toThrow(expect.objectContaining({ code: 'session_content_mode_mismatch' }));
    expect(() => openSessionStoredContent({
      ...plain,
      content: sealSessionStoredContent({ ...e2ee, payload }),
    })).toThrow(expect.objectContaining({ code: 'session_content_mode_mismatch' }));

    const content = sealSessionStoredContent({ ...e2ee, payload });
    expect(() => openSessionStoredContent({
      mode: 'e2ee',
      ctx: { encryptionKey: new Uint8Array(32).fill(91), encryptionVariant: 'dataKey' },
      content,
    })).toThrow(expect.objectContaining({ code: 'session_content_unavailable' }));
  });
});

describe('Session presentation content evidence', () => {
  const effectiveAccess = {
    v: 1,
    level: 'view',
    sources: [{ kind: 'team', teamId: 'team', requiredByTeamPolicy: false }],
    capabilities: projectSessionAccessCapabilitiesV1({
      owner: false,
      grants: [{ accessLevel: 'view', canApprovePermissions: false }],
    }),
  } as const;
  const sharedMetadata = { v: 1 };
  const metadata = encryptSessionPayload({
    ctx: { encryptionKey: dek, encryptionVariant: 'dataKey' },
    payload: sharedMetadata,
  });
  const input = {
    credentials: credentials[0],
    accountEncryptionMode: 'e2ee',
    rawSession: {
      encryptionMode: 'e2ee',
      metadataLayoutVersion: 1,
      metadata,
      dataEncryptionKey,
      effectiveAccess,
      share: null,
    },
  } as const;

  it('reports authenticated shared content without requiring owner-private metadata', () => {
    expect(readSessionPresentationContent(input)).toEqual({
      metadata: sharedMetadata,
      content: { mode: 'e2ee', keyState: 'opened' },
    });
    expect(tryDecryptSessionPresentationMetadataView(input)).toEqual(sharedMetadata);
  });

  it.each([
    [{ status: 'available' }, 'access_pending'],
    [{ status: 'unavailable', reason: 'plain_account' }, 'setup_required'],
    [{ status: 'unavailable', reason: 'encryption_setup_required' }, 'setup_required'],
    [{ status: 'unavailable', reason: 'encryption_inconsistent' }, 'inconsistent'],
    [undefined, 'unknown'],
  ] as const)('uses actual recipient readiness %j for an absent envelope', (recipientEnvelopeReadiness, keyState) => {
    expect(readSessionPresentationContent({
      ...input,
      recipientEnvelopeReadiness,
      rawSession: { ...input.rawSession, dataEncryptionKey: null },
    })).toEqual({ metadata: null, content: { mode: 'e2ee', keyState } });
  });

  it.each(['', 'not-base64', 123])('reports present malformed envelope repair, never pending or owner fallback: %j', (invalid) => {
    expect(readSessionPresentationContent({
      ...input,
      recipientEnvelopeReadiness: { status: 'available' },
      rawSession: { ...input.rawSession, dataEncryptionKey: invalid },
    })).toEqual({ metadata: null, content: { mode: 'e2ee', keyState: 'inconsistent' } });
  });

  it('distinguishes an envelope sealed to another Account from failed content authentication', () => {
    const otherPublicKey = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(45)).publicKey;
    const wrongRecipientEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey: otherPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(46),
    }));
    expect(readSessionPresentationContent({
      ...input,
      rawSession: { ...input.rawSession, dataEncryptionKey: wrongRecipientEnvelope },
    })).toEqual({ metadata: null, content: { mode: 'e2ee', keyState: 'inconsistent' } });

    const wrongContent = encryptSessionPayload({
      ctx: { encryptionKey: new Uint8Array(32).fill(47), encryptionVariant: 'dataKey' },
      payload: sharedMetadata,
    });
    expect(readSessionPresentationContent({
      ...input,
      rawSession: { ...input.rawSession, metadata: wrongContent },
    })).toEqual({ metadata: null, content: { mode: 'e2ee', keyState: 'content_unavailable' } });
  });

  it('does not call an authenticated unsupported metadata layout a content authentication failure', () => {
    const result = readSessionPresentationContent({
      ...input,
      rawSession: { ...input.rawSession, metadataLayoutVersion: 99 },
    });
    expect(result.metadata).toBeNull();
    expect(result.content).not.toEqual({ mode: 'e2ee', keyState: 'content_unavailable' });
  });

  it('does not mistake authenticated JSON null for failed authentication', () => {
    const result = readSessionPresentationContent({
      ...input,
      rawSession: {
        ...input.rawSession,
        metadata: encryptSessionPayload({
          ctx: { encryptionKey: dek, encryptionVariant: 'dataKey' },
          payload: null,
        }),
      },
    });
    expect(result.metadata).toBeNull();
    expect(result.content).not.toEqual({ mode: 'e2ee', keyState: 'content_unavailable' });
  });

  it('does not infer owner fallback from share-null when marked current access is malformed', () => {
    const result = readSessionPresentationContent({
      ...input,
      rawSession: {
        ...input.rawSession,
        dataEncryptionKey: null,
        effectiveAccess: { v: 1 },
        metadata: encryptSessionPayload({
          ctx: { encryptionKey: secret, encryptionVariant: 'legacy' },
          payload: sharedMetadata,
        }),
      },
    });
    expect(result).toEqual({ metadata: null, content: { mode: 'e2ee', keyState: 'unknown' } });
  });

  it('does not call an unsupported ciphertext version a content authentication failure', () => {
    const unsupported = Buffer.from(metadata, 'base64');
    unsupported[0] = 99;
    const result = readSessionPresentationContent({
      ...input,
      rawSession: { ...input.rawSession, metadata: unsupported.toString('base64') },
    });
    expect(result.metadata).toBeNull();
    expect(result.content).not.toEqual({ mode: 'e2ee', keyState: 'content_unavailable' });
  });

  it.each(credentials)('preserves authenticated absent-envelope owner content for $encryption.type', (credential) => {
    const ctx = resolveSessionEncryptionContextFromCredentials(credential);
    const historicalMetadata = { name: 'Historical owner content' };
    expect(readSessionPresentationContent({
      credentials: credential,
      accountEncryptionMode: 'e2ee',
      rawSession: {
        encryptionMode: 'e2ee',
        dataEncryptionKey: null,
        metadata: encryptSessionPayload({ ctx, payload: historicalMetadata }),
      },
    })).toEqual({ metadata: historicalMetadata, content: { mode: 'e2ee', keyState: 'opened' } });
  });

  it('keeps plain Sessions keyless independently of Account mode and envelope readiness', () => {
    expect(readSessionPresentationContent({
      credentials: { token: 'plain', encryption: null },
      accountEncryptionMode: 'plain',
      rawSession: { encryptionMode: 'plain', metadata: JSON.stringify({ name: 'Plain' }) },
    })).toEqual({ metadata: { name: 'Plain' }, content: { mode: 'plain' } });
  });

  it('does not promote an opened envelope without observed content into readable presentation', () => {
    expect(readSessionPresentationContent({
      ...input,
      rawSession: { ...input.rawSession, metadata: undefined },
    })).toEqual({ metadata: null, content: { mode: 'e2ee', keyState: 'unknown' } });
  });

  it('keeps authenticated non-metadata content unknown to presentation', () => {
    expect(readSessionPresentationContent({
      ...input,
      rawSession: {
        ...input.rawSession,
        metadata: encryptSessionPayload({
          ctx: { encryptionKey: dek, encryptionVariant: 'dataKey' },
          payload: ['authenticated', 'unsupported metadata shape'],
        }),
      },
    })).toEqual({ metadata: null, content: { mode: 'e2ee', keyState: 'unknown' } });
  });

  it.each(credentials)('reports failed historical owner authentication without guessing another cipher for $encryption.type', (credential) => {
    expect(readSessionPresentationContent({
      credentials: credential,
      accountEncryptionMode: 'e2ee',
      rawSession: {
        encryptionMode: 'e2ee',
        dataEncryptionKey: null,
        metadata: encryptSessionPayload({
          ctx: { encryptionKey: dek, encryptionVariant: credential.encryption.type },
          payload: { name: 'Wrong historical key' },
        }),
      },
    })).toEqual({ metadata: null, content: { mode: 'e2ee', keyState: 'content_unavailable' } });
  });
});
