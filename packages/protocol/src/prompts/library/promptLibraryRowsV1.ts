import tweetnacl from 'tweetnacl';
import { isAccountScopedBlobCiphertextForKind } from '../../crypto/accountScopedCipherEnvelope.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import {
  PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1, PROMPT_LIBRARY_ACCOUNT_CIPHER_KIND_V1,
  PromptLibraryRecordV1Schema, StoredPromptLibraryRecordV1Schema, StoredPromptLibraryContentV1Schema,
  type PromptLibraryCatalogKeyV1, type PromptLibraryRecordV1, type PromptLibraryContentV1,
} from './promptLibrarySchemasV1.js';
export * from './promptLibrarySchemasV1.js';

export function buildPromptLibraryPhysicalKeyV1(key: PromptLibraryCatalogKeyV1): string {
  return PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1 + PromptLibraryCatalogKeyV1Schema.parse(key);
}
export function parsePromptLibraryPhysicalKeyV1(key: string): PromptLibraryCatalogKeyV1 | null {
  if (!key.startsWith(PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1)) return null;
  const parsed = PromptLibraryCatalogKeyV1Schema.safeParse(key.slice(PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1.length));
  return parsed.success ? parsed.data : null;
}

export function assertPromptLibraryContentForModeV1(content: PromptLibraryContentV1, mode: 'plain' | 'e2ee'): void {
  if ((mode === 'plain') !== (content.t === 'plain') || (content.t === 'encrypted'
    && !isAccountScopedBlobCiphertextForKind({ kind: PROMPT_LIBRARY_ACCOUNT_CIPHER_KIND_V1, ciphertext: content.c }))) throw new Error('account-mode-mismatch');
}
export function openPromptLibraryContentV1(input: Readonly<{
  key: PromptLibraryCatalogKeyV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; content: unknown;
}>): Readonly<{ status: 'opened'; record: PromptLibraryRecordV1 }> | Readonly<{
  status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content';
}> {
  const content = StoredPromptLibraryContentV1Schema.safeParse(input.content);
  if (!content.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  try { assertPromptLibraryContentForModeV1(content.data, input.mode); }
  catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  let value: unknown;
  if (content.data.t === 'plain') value = content.data.v;
  else {
    if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    value = openAccountScopedBlobCiphertext({ kind: PROMPT_LIBRARY_ACCOUNT_CIPHER_KIND_V1, material: input.material, ciphertext: content.data.c })?.value;
  }
  const record = StoredPromptLibraryRecordV1Schema.safeParse(value);
  return record.success && record.data.key === input.key
    ? { status: 'opened', record: record.data } : { status: 'unavailable', reason: 'invalid-stored-content' };
}
export function sealPromptLibraryContentV1(input: Readonly<{
  record: PromptLibraryRecordV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; randomBytes?: (length: number) => Uint8Array;
}>): PromptLibraryContentV1 {
  const record = PromptLibraryRecordV1Schema.parse(input.record);
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    return { t: 'plain', v: record };
  }
  if (!input.material) throw new Error('encryption-material-unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: PROMPT_LIBRARY_ACCOUNT_CIPHER_KIND_V1,
    material: input.material, payload: record, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}
