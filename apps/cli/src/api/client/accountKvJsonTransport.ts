import axios from 'axios';
import { z } from 'zod/mini';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import type { ScmReviewedMarksJsonTransport } from '@happier-dev/protocol/scm';
import type { AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import type { StoredCredentials } from '@/persistence';
import { decodeBase64, encodeBase64, decryptResult, encrypt } from '@/api/encryption';
import { readRequesterAccountEncryptionCurrentness } from './accountEncryptionCurrentnessObservation';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export type AccountKvAuthorizationRequest = Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>;
export type CliAccountKvJsonTransportParams = Readonly<{
  credentials: StoredCredentials; key: string; serverBaseUrl?: string; signal?: AbortSignal; shouldContinue?: () => boolean;
  resolveAuthorizationHeaders: (request: AccountKvAuthorizationRequest) => Readonly<Record<string, string>> | null;
}>;
class AccountKvJsonTransportError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
/** One persisted-mode/content-key admission for CLI Account storage adapters. */
export async function resolveCliAccountStorageContext(params: Readonly<{
  credentials: StoredCredentials; serverBaseUrl?: string; signal?: AbortSignal; shouldContinue?: () => boolean;
  authorizationHeaders?: Readonly<Record<string, string>>;
}>) {
  const currentness = await readRequesterAccountEncryptionCurrentness({ token: params.credentials.token,
    ...(params.serverBaseUrl ? { serverBaseUrl: params.serverBaseUrl } : {}),
    ...(params.authorizationHeaders ? { authorizationHeaders: params.authorizationHeaders } : {}),
    ...(params.signal ? { signal: params.signal } : {}) });
  if (params.signal?.aborted || params.shouldContinue?.() === false) throw new AccountKvJsonTransportError('account_kv_scope_retired', 'The captured Account storage scope retired');
  if (currentness.mode === 'plain') return { mode: 'plain' as const, material: null };
  const encryption = params.credentials.encryption;
  if (!encryption) throw new AccountKvJsonTransportError('account_storage_currentness_unavailable', 'Account encryption material is unavailable');
  const material = encryption.type === 'legacy' ? { type: 'legacy' as const, secret: encryption.secret }
    : { type: 'dataKey' as const, machineKey: encryption.machineKey };
  const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material,
    ...(encryption.type === 'dataKey' ? { dataKeyPublicKey: encryption.publicKey } : {}) });
  if (convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) !== currentness.contentKeyFingerprint) {
    throw new AccountKvJsonTransportError('account_storage_currentness_unavailable', 'Account content-key fingerprint mismatch');
  }
  return { mode: 'e2ee' as const, encryption, material };
}
const storedItem = z.strictObject({ key: z.string(), value: z.string(), version: z.number().check(z.int(), z.nonnegative()) });
const mutationResponse = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), results: z.array(z.strictObject({ key: z.string(), version: z.number().check(z.int(), z.nonnegative()) })) }),
  z.strictObject({ success: z.literal(false), errors: z.array(z.strictObject({ key: z.string(), error: z.literal('version-mismatch'),
    version: z.number().check(z.int(), z.minimum(-1)), value: z.nullable(z.string()) })) }),
]);

/** Account mode/fingerprint admission and opaque JSON/CAS, shared by CLI domain operations. */
export function createCliAccountKvJsonTransport(params: CliAccountKvJsonTransportParams): ScmReviewedMarksJsonTransport {
  const collection = createCliAccountKvJsonCollectionTransport(params);
  return {
    read: () => collection.read(params.key),
    compareAndSet: async (value, version) => {
      const result = await collection.mutate([{ key: params.key, value, version }]);
      if (result.success) {
        const row = result.results.find(row => row.key === params.key);
        if (!row) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV mutation omitted its result');
        return { success: true, version: row.version };
      }
      const row = result.errors.find(row => row.key === params.key);
      if (!row) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV mutation omitted its conflict');
      return { success: false, value: row.value, version: row.version, ...(row.value === null ? { tombstone: true as const } : {}) };
    },
  };
}

/** The same raw Account namespace and mode admission, including atomic multi-key intents. */
export function createCliAccountKvJsonCollectionTransport(params: Omit<CliAccountKvJsonTransportParams, 'key'>): AccountJsonKvCollectionPort {
  const base = (params.serverBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  const check = () => {
    if (params.signal?.aborted || params.shouldContinue?.() === false) throw new AccountKvJsonTransportError('account_kv_scope_retired', 'The captured Account KV scope retired');
  };
  const headers = (request: AccountKvAuthorizationRequest) => {
    check(); const value = params.resolveAuthorizationHeaders(request);
    if (!value) throw new AccountKvJsonTransportError('not_authenticated', 'Account authorization is unavailable');
    return value;
  };
  const context = async () => {
    return resolveCliAccountStorageContext({ credentials: params.credentials, serverBaseUrl: base,
      authorizationHeaders: headers({ method: 'GET', path: '/v1/account/encryption/currentness' }),
      signal: params.signal, shouldContinue: params.shouldContinue });
  };
  type Context = Awaited<ReturnType<typeof context>>;
  const encode = (value: unknown, admitted: Context): string => {
    if (admitted.mode === 'plain') return encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: value })));
    const material = admitted.encryption;
    return encodeBase64(encrypt(material.type === 'legacy' ? material.secret : material.machineKey, material.type, value));
  };
  const decode = (encoded: string, admitted: Context): unknown => {
    let envelope: z.infer<typeof StoredJsonContentEnvelopeSchema> | null = null;
    try { const parsed = StoredJsonContentEnvelopeSchema.safeParse(JSON.parse(new TextDecoder().decode(decodeBase64(encoded))));
      if (parsed.success) envelope = parsed.data; } catch { /* Released ciphertext-only E2EE is not JSON. */ }
    if ((envelope?.t === 'plain' ? 'plain' : 'e2ee') !== admitted.mode) {
      throw new AccountKvJsonTransportError('account_stored_json_mode_mismatch', 'Stored Account content does not match its authoritative mode');
    }
    if (envelope?.t === 'plain') return envelope.v;
    if (admitted.mode !== 'e2ee') throw new AccountKvJsonTransportError('account_stored_json_mode_mismatch', 'Encrypted Account content requires E2EE mode');
    const material = admitted.encryption;
    let ciphertext: Uint8Array;
    try { ciphertext = decodeBase64(envelope?.t === 'encrypted' ? envelope.c : encoded); }
    catch { throw new AccountKvJsonTransportError('account_kv_content_unreadable', 'The encrypted Account KV record could not be opened'); }
    const result = decryptResult(material.type === 'legacy' ? material.secret : material.machineKey, material.type, ciphertext);
    if (result.status !== 'authenticated') throw new AccountKvJsonTransportError('account_kv_content_unreadable', 'The encrypted Account KV record could not be opened');
    return result.value;
  };
  return {
    read: async key => {
      check(); const admitted = await context(); const path = `/v1/kv/${encodeURIComponent(key)}`;
      const response = await axios.get(`${base}${path}`, { headers: headers({ method: 'GET', path }), validateStatus: () => true,
        ...(params.signal ? { signal: params.signal } : {}) });
      check(); if (response.status === 404) return { value: null, version: -1 };
      if (response.status !== 200) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV read failed');
      const item = storedItem.parse(response.data);
      if (item.key !== key) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV read returned another key');
      return { value: decode(item.value, admitted), version: item.version };
    },
    list: async prefix => {
      check(); const admitted = await context();
      const rows: { key: string; value: unknown; version: number }[] = [];
      const seen = new Set<string>();
      let afterKey: string | undefined;
      for (;;) {
        // The HTTP KV owner admits at most 1,000 records per page, not per Account.
        const query = new URLSearchParams({ prefix, limit: '1000', ...(afterKey ? { afterKey } : {}) });
        const path = `/v1/kv?${query}`;
        const response = await axios.get(`${base}${path}`, { headers: headers({ method: 'GET', path }), validateStatus: () => true,
          ...(params.signal ? { signal: params.signal } : {}) });
        check();
        if (response.status !== 200) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV list failed');
        const page = z.strictObject({ items: z.array(storedItem) }).parse(response.data).items;
        for (const row of page) {
          if (!row.key.startsWith(prefix) || seen.has(row.key)) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV list returned invalid membership');
          seen.add(row.key); rows.push({ ...row, value: decode(row.value, admitted) });
        }
        if (page.length < 1000) return rows;
        afterKey = page[page.length - 1]!.key;
      }
    },
    mutate: async mutations => {
      check(); const admitted = await context();
      const body = { mutations: mutations.map(row => ({ key: row.key, value: encode(row.value, admitted), version: row.version })) };
      const response = await axios.post(`${base}/v1/kv`, body,
        { headers: headers({ method: 'POST', path: '/v1/kv', body }), validateStatus: () => true, ...(params.signal ? { signal: params.signal } : {}) });
      check();
      if (response.status !== 200 && response.status !== 409) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV mutation failed');
      const result = mutationResponse.parse(response.data);
      if (result.success) {
        return result;
      }
      if (result.errors.length === 0) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV mutation omitted its conflict');
      return { success: false, errors: result.errors.map(row => ({ key: row.key, value: row.value === null ? null : decode(row.value, admitted), version: row.version })) };
    },
  };
}
