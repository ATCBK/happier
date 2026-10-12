import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { ACCOUNT_SETTING_MAX_STRING_BYTES } from './catalog/accountSettingBounds.js';
import {
  SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1,
  SavedSecretResourceContentV1Schema,
  SavedSecretResourceStoredContentV1Schema,
  openSavedSecretResourceStoredContentV1,
  sealSavedSecretResourceStoredContentV1,
} from './savedSecretResourceContentV1.js';
import {
  SavedSecretResourceContentV1Schema as BrowserSafeSavedSecretResourceContentV1Schema,
  SavedSecretResourceStoredContentV1Schema as BrowserSafeSavedSecretResourceStoredContentV1Schema,
} from './savedSecretResourceContentSchemaV1.js';

const content = Object.freeze({
  v: 1 as const,
  name: 'Production token',
  kind: 'token' as const,
  value: 'secret-value',
});

function deterministicRandomBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index + 1) & 0xff);
}

function sealRawPayload(payload: unknown, resourceDataKey: Uint8Array): string {
  const nonce = deterministicRandomBytes(tweetnacl.secretbox.nonceLength);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const boxed = tweetnacl.secretbox(plaintext, nonce, resourceDataKey);
  const combined = new Uint8Array(nonce.length + boxed.length);
  combined.set(nonce);
  combined.set(boxed, nonce.length);
  return encodeBase64(combined, 'base64');
}

describe('savedSecretResourceContentV1', () => {
  it('opens retained plain and encrypted Secret content while keeping declared bindings and writes strict', () => {
    const resourceDataKey = new Uint8Array(32).fill(7);
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'resource-1', mode: 'plain',
      storedContent: { t: 'plain', v: { ...content, retired: true }, retired: true } })).toEqual(content);
    const payload = { v: 1, resourceId: 'resource-1', mode: 'e2ee', content: { ...content, retired: true }, retired: true };
    const storedContent = { t: 'encrypted', c: sealRawPayload(payload, resourceDataKey), retired: true };
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'resource-1', mode: 'e2ee', storedContent, resourceDataKey }))
      .toEqual(content);
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'resource-2', mode: 'e2ee', storedContent, resourceDataKey }))
      .toBeNull();
    expect(openSavedSecretResourceStoredContentV1({ resourceId: 'resource-1', mode: 'plain',
      storedContent: { t: 'plain', v: { ...content, value: '' }, retired: true } })).toBeNull();
    expect(SavedSecretResourceContentV1Schema.safeParse(payload.content).success).toBe(false);
  });
  it('keeps the action-admitted content schemas browser-neutral while crypto retains the compatibility export', () => {
    expect(SavedSecretResourceContentV1Schema).toBe(BrowserSafeSavedSecretResourceContentV1Schema);
    expect(SavedSecretResourceStoredContentV1Schema).toBe(BrowserSafeSavedSecretResourceStoredContentV1Schema);
  });

  it('keeps content and both stored envelope arms closed while reusing Saved Secret field bounds', () => {
    expect(SavedSecretResourceContentV1Schema.parse(content)).toEqual(content);
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...content, extra: true }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...content, name: 'n'.repeat(101) }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...content, kind: 'certificate' }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.safeParse({ ...content, value: '' }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.parse({ ...content, value: ' \t ' }).value).toBe(' \t ');
    expect(SavedSecretResourceContentV1Schema.safeParse({
      ...content,
      value: 'x'.repeat(ACCOUNT_SETTING_MAX_STRING_BYTES + 1),
    }).success).toBe(false);
    expect(SavedSecretResourceContentV1Schema.safeParse({
      ...content,
      value: '\u0000'.repeat(ACCOUNT_SETTING_MAX_STRING_BYTES),
    }).success).toBe(false);

    expect(SavedSecretResourceStoredContentV1Schema.safeParse({ t: 'plain', v: content, extra: true }).success).toBe(false);
    expect(SavedSecretResourceStoredContentV1Schema.safeParse({ t: 'encrypted', c: 'AA==', extra: true }).success).toBe(false);
    expect(SavedSecretResourceStoredContentV1Schema.safeParse({ t: 'encrypted', c: 'AA==' }).success).toBe(false);
    expect(SavedSecretResourceStoredContentV1Schema.safeParse({ t: 'encrypted', c: 'not canonical base64' }).success).toBe(false);
    expect(SavedSecretResourceStoredContentV1Schema.safeParse({
      t: 'encrypted',
      c: encodeBase64(new Uint8Array(SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1), 'base64'),
    }).success).toBe(true);
    expect(SavedSecretResourceStoredContentV1Schema.safeParse({
      t: 'encrypted',
      c: encodeBase64(new Uint8Array(SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1 + 1), 'base64'),
    }).success).toBe(false);
  });

  it('round-trips E2EE content and binds ciphertext to its resource id and mode', () => {
    const resourceDataKey = new Uint8Array(32).fill(7);
    const stored = sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'e2ee',
      content,
      resourceDataKey,
      randomBytes: deterministicRandomBytes,
    });

    expect(stored.t).toBe('encrypted');
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'e2ee',
      storedContent: stored,
      resourceDataKey,
    })).toEqual(content);
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-2',
      mode: 'e2ee',
      storedContent: stored,
      resourceDataKey,
    })).toBeNull();
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'plain',
      storedContent: stored,
    })).toBeNull();

    const corrupted = decodeBase64(stored.t === 'encrypted' ? stored.c : '', 'base64');
    corrupted[corrupted.length - 1] ^= 0xff;
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'e2ee',
      storedContent: { t: 'encrypted', c: encodeBase64(corrupted, 'base64') },
      resourceDataKey,
    })).toBeNull();
  });

  it.each([
    ['wrong codec version', { v: 2, resourceId: 'resource-1', mode: 'e2ee', content }],
    ['wrong bound mode', { v: 1, resourceId: 'resource-1', mode: 'plain', content }],
  ])('rejects decrypted payloads with %s', (_label, payload) => {
    const resourceDataKey = new Uint8Array(32).fill(7);
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'e2ee',
      storedContent: { t: 'encrypted', c: sealRawPayload(payload, resourceDataKey) },
      resourceDataKey,
    })).toBeNull();
  });

  it('seals and opens a plain resource without key material or randomness', () => {
    const stored = sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'plain',
      content,
    });

    expect(stored).toEqual({ t: 'plain', v: content });
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'plain',
      storedContent: stored,
    })).toEqual(content);
    expect(openSavedSecretResourceStoredContentV1({
      resourceId: 'resource-1',
      mode: 'e2ee',
      storedContent: stored,
      resourceDataKey: new Uint8Array(32).fill(7),
    })).toBeNull();
  });
});
