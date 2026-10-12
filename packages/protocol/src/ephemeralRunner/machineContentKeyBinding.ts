import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import tweetnacl from 'tweetnacl';

import {
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import { encodeBase64 } from '../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { verifyEd25519Signature } from '../crypto/ed25519.js';
import { decodeCanonicalBase64UrlFixedLength } from '../machines/peer/mediation/strictBase64Url.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import {
  RUNNER_MACHINE_CONTENT_KEY_FINGERPRINT_PREFIX,
  RunnerMachineContentKeyBindingPayloadV1Schema,
  RunnerMachineContentKeyBindingV1Schema,
  RunnerMachineContentKeyVerifierFactPayloadV1Schema,
  readRunnerMachineContentKeyBindingSignedPayloadV1,
  type RunnerMachineContentKeyBindingPayloadV1,
  type RunnerMachineContentKeyBindingV1,
  type RunnerMachineContentKeyVerifierFactPayloadV1,
} from './machineContentKeyBindingSchema.js';

export {
  RUNNER_MACHINE_CONTENT_KEY_FINGERPRINT_PREFIX,
  RunnerMachineContentKeyBindingPayloadV1Schema,
  RunnerMachineContentKeyBindingV1Schema,
  RunnerMachineContentKeyVerifierFactPayloadV1Schema,
  readRunnerMachineContentKeyBindingSignedPayloadV1,
  type RunnerMachineContentKeyBindingPayloadV1,
  type RunnerMachineContentKeyBindingV1,
  type RunnerMachineContentKeyVerifierFactPayloadV1,
};

const RUNNER_MACHINE_CONTENT_KEY_VERIFIER_BLOB_KIND = 'runner_machine_content_key_verifier' as const;

/**
 * Seals the creator's activation verifier identity for every authorized reader
 * of the same Account.
 *
 * The creator is the only party that knows the activation identity is genuine,
 * and it already holds Account E2EE material. Sealing the fact under the
 * incumbent Account-scoped cipher hands the same non-secret verifier to a
 * second device or a daemon without giving the Home anything it can forge: the
 * Home holds no Account material, so it can neither produce nor alter the blob.
 * The activation and Machine identities travel inside the sealed payload, so a
 * fact lifted from another Runner cannot be replayed onto this Machine row.
 */
export function sealRunnerMachineContentKeyVerifierFactV1(params: Readonly<{
  payload: RunnerMachineContentKeyVerifierFactPayloadV1;
  material: AccountScopedCryptoMaterial;
  randomBytes: (length: number) => Uint8Array;
}>): string {
  return sealAccountScopedBlobCiphertext({
    kind: RUNNER_MACHINE_CONTENT_KEY_VERIFIER_BLOB_KIND,
    material: params.material,
    payload: RunnerMachineContentKeyVerifierFactPayloadV1Schema.parse(params.payload),
    randomBytes: params.randomBytes,
  });
}

/**
 * Recovers the verifier identity a reader without creator device custody must
 * use, or `null` when the fact is absent, unopenable or names another Runner.
 */
export function openRunnerMachineContentKeyVerifierFactV1(params: Readonly<{
  ciphertext: string | null | undefined;
  material: AccountScopedCryptoMaterial;
  expectedActivationId: string;
  expectedMachineId: string;
}>): string | null {
  if (typeof params.ciphertext !== 'string' || params.ciphertext.length === 0) return null;
  const opened = openAccountScopedBlobCiphertext({
    kind: RUNNER_MACHINE_CONTENT_KEY_VERIFIER_BLOB_KIND,
    material: params.material,
    ciphertext: params.ciphertext,
  });
  if (!opened || opened.format !== 'account_scoped_v1') return null;
  const fact = createStoredReadSchema(RunnerMachineContentKeyVerifierFactPayloadV1Schema).safeParse(opened.value);
  if (!fact.success
    || fact.data.activationId !== params.expectedActivationId
    || fact.data.machineId !== params.expectedMachineId) return null;
  return fact.data.activationSigningPublicKey;
}

export function computeRunnerMachineContentKeyFingerprintV1(key: Uint8Array): string {
  if (key.length !== 32) throw new Error('Runner Machine content key must contain exactly 32 bytes');
  return `${RUNNER_MACHINE_CONTENT_KEY_FINGERPRINT_PREFIX}${bytesToHex(sha256(key))}`;
}

/**
 * Signs the binding with the creator-generated activation signing identity.
 *
 * The creator device generates that identity at package creation and retains
 * its private key device-locally through proof publication, so the proof needs
 * no Account signing private key: a DataKey or token-only creator credential
 * produces exactly the same binding. Callers pass the secret key alone; the
 * public half is derived here so a caller can never present a signature under
 * one identity while naming another.
 */
export function signRunnerMachineContentKeyBindingV1(params: Readonly<{
  payload: RunnerMachineContentKeyBindingPayloadV1;
  activationSigningSecretKey: Uint8Array;
}>): RunnerMachineContentKeyBindingV1 {
  const payload = RunnerMachineContentKeyBindingPayloadV1Schema.parse(params.payload);
  if (params.activationSigningSecretKey.length !== tweetnacl.sign.secretKeyLength) {
    throw new Error('Invalid activation signing key');
  }
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(payload));
  return {
    ...payload,
    accountSignatureBase64Url: encodeBase64(
      tweetnacl.sign.detached(bytes, params.activationSigningSecretKey),
      'base64url',
    ),
  };
}

/**
 * Verifies the binding against an independently trusted signing identity.
 *
 * `expectedAccountSigningPublicKey` is the creator's activation signing public
 * key. It must come from the verifier's own trusted scope — the Runner's local
 * activation package, the Home's persisted activation row, or the creator's
 * device-local activation custody — and never from the Home-published Machine
 * row, so substituting verifier key, binding and an Account-openable envelope
 * together still fails.
 */
export function verifyRunnerMachineContentKeyBindingV1(params: Readonly<{
  binding: unknown;
  expectedPayload: unknown;
  /** Trusted creator activation signing public key; not a Home-published field. */
  expectedAccountSigningPublicKey: string;
}>): RunnerMachineContentKeyBindingV1 | null {
  const binding = RunnerMachineContentKeyBindingV1Schema.safeParse(params.binding);
  if (!binding.success) return null;
  // The sealed verifier fact rides beside the signature and is not signed, so
  // both sides are reduced to the exact payload the creator signed.
  const payload = readRunnerMachineContentKeyBindingSignedPayloadV1(binding.data);
  const expected = readRunnerMachineContentKeyBindingSignedPayloadV1(params.expectedPayload);
  if (!payload || !expected) return null;
  if (createCanonicalJsonSigningInput(payload) !== createCanonicalJsonSigningInput(expected)) return null;
  const publicKey = decodeCanonicalBase64UrlFixedLength(params.expectedAccountSigningPublicKey, 32);
  const signature = decodeCanonicalBase64UrlFixedLength(binding.data.accountSignatureBase64Url, 64);
  if (!publicKey || !signature) return null;
  return verifyEd25519Signature(
    new TextEncoder().encode(createCanonicalJsonSigningInput(payload)), signature, publicKey,
  ) ? binding.data : null;
}
