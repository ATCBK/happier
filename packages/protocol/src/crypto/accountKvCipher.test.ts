import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { createAccountKvCipher, openAccountKvJsonRow } from './accountKvCipher.js';
import { deriveAccountMachineKeyFromRecoverySecret } from './accountScopedCipher.js';
import { decodeBase64, encodeBase64 } from './base64.js';
import { openSessionDataKeyBundleV0, sealSessionDataKeyBundleV0 } from './sessionDataKeyBundleWebCrypto.js';
import { legacyAccountKvVectors } from './fixtures/accountKvLegacyV0.js';

const secret = new Uint8Array(32).fill(7);
const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
const dataKeyCipher = (key: Uint8Array) => ({
  seal: async (value: unknown) => encodeBase64(await sealSessionDataKeyBundleV0(value, key)),
  open: (encoded: string) => openSessionDataKeyBundleV0(decodeBase64(encoded), key),
});
const legacy = () => createAccountKvCipher({ mode: 'e2ee', material: { type: 'legacy', secret }, dataKeyCipher });
const paired = () => createAccountKvCipher({ mode: 'e2ee', material: { type: 'dataKey', machineKey }, dataKeyCipher });
const envelope = (value: unknown) => encodeBase64(new TextEncoder().encode(JSON.stringify(value)));

describe('raw Account-KV canonical cipher', () => {
  it('opens both pinned predecessor shapes and makes them readable to paired data-key custody', async () => {
    for (const row of legacyAccountKvVectors) {
      expect(await legacy().open(row.encoded)).toEqual({ value: row.value, needsReseal: true });
      expect(await paired().open(await legacy().seal(row.value))).toEqual({ value: row.value, needsReseal: false });
      expect(await legacy().open(envelope({ t: 'encrypted', c: row.encoded }))).toEqual({ value: row.value, needsReseal: true });
    }
  });

  it('preserves complete authenticated JSON before projection and does not confuse falsy values with failure', async () => {
    const value = { unknownFutureField: { nested: [null, false, 0, '', 'é🚀'] }, predecessor: legacyAccountKvVectors[0].value };
    const nonce = new Uint8Array(24).fill(2);
    const body = nacl.secretbox(new TextEncoder().encode(JSON.stringify(value)), nonce, secret);
    const bytes = new Uint8Array(nonce.length + body.length);
    bytes.set(nonce); bytes.set(body, nonce.length);
    let stored = { value: encodeBase64(bytes), version: 4 };
    expect(await openAccountKvJsonRow({ row: stored, cipher: legacy(), requireCurrent: () => {},
      compareAndSet: async (encoded, version) => {
        expect(version).toBe(stored.version);
        stored = { value: encoded, version: version + 1 };
        return { success: true, version: stored.version };
      },
    })).toEqual({ value, version: 5 });
    expect(await paired().open(stored.value)).toEqual({ value, needsReseal: false });
    for (const falsy of [null, false, 0, '']) {
      expect(await legacy().open(await paired().seal(falsy))).toEqual({ value: falsy, needsReseal: false });
    }
  });

  it('preserves a concurrent deletion instead of reviving a legacy row', async () => {
    expect(await openAccountKvJsonRow({ row: { value: legacyAccountKvVectors[0].encoded, version: 6 }, cipher: legacy(),
      requireCurrent: () => {}, compareAndSet: async () => ({ success: false, value: null, version: 7 }),
    })).toEqual({ value: null, version: 7, tombstone: true });
  });

  it('preserves legacy data after a failed re-seal transport and refuses a retired scope before mutation', async () => {
    const row = { value: legacyAccountKvVectors[1].encoded, version: 6 };
    await expect(openAccountKvJsonRow({ row, cipher: legacy(), requireCurrent: () => {},
      compareAndSet: async () => { throw new Error('network unavailable'); },
    })).rejects.toThrow('network unavailable');
    expect(row).toEqual({ value: legacyAccountKvVectors[1].encoded, version: 6 });
    await expect(openAccountKvJsonRow({ row, cipher: legacy(), requireCurrent: () => { throw new Error('retired'); },
      compareAndSet: async () => { throw new Error('must not mutate'); },
    })).rejects.toThrow('retired');
  });

  it('requires explicit envelope/mode agreement, without constructing material for plain Accounts', async () => {
    const plain = createAccountKvCipher({ mode: 'plain', material: null,
      dataKeyCipher: () => { throw new Error('must not construct a key'); } });
    const value = { nested: ['preserved'] };
    expect(await plain.open(await plain.seal(value))).toEqual({ value, needsReseal: false });
    await expect(legacy().open(await plain.seal(value))).rejects.toMatchObject({ code: 'account_stored_json_mode_mismatch' });
    await expect(plain.open(legacyAccountKvVectors[0].encoded)).rejects.toMatchObject({ code: 'account_stored_json_mode_mismatch' });
    await expect(legacy().open(envelope({ t: 'encrypted', c: 42 }))).rejects.toMatchObject({ code: 'account_kv_content_unreadable' });
    await expect(paired().open(legacyAccountKvVectors[0].encoded)).rejects.toMatchObject({ code: 'account_kv_content_unreadable' });
  });
});
