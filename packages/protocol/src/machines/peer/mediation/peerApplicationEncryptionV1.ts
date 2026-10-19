import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod/mini';

import { decodeBase64, encodeBase64 } from '../../../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../../../crypto/canonicalJson.js';
import { VoiceMediaApplicationKindV1Schema } from './voiceMediaV1.js';

export const PEER_APPLICATION_ENCRYPTION_VERSION_V1 = 1 as const;
export const PEER_APPLICATION_ENCRYPTION_SUITE_V1 = 'aes-256-gcm' as const;
export const PEER_APPLICATION_ENCRYPTION_DATA_KEY_BYTES_V1 = 32;
export const PEER_APPLICATION_ENCRYPTION_NONCE_BYTES_V1 = 12;
export const PEER_APPLICATION_ENCRYPTION_AUTH_TAG_BYTES_V1 = 16;
export const PEER_APPLICATION_ENCRYPTION_DATA_KEY_ENVELOPE_MAX_BYTES_V1 = 1024;
export const PEER_APPLICATION_ENCRYPTION_CIPHERTEXT_MAX_BYTES_V1 = 512 * 1024;
export const PEER_APPLICATION_ENCRYPTION_INSTALL_PROOF_V1 = 'happier.peer-application.install.v1' as const;
export const PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1 = 'happier.peer-application.confirmed.v1' as const;

const Sha256DigestSchema = lazyZodSchema(() => z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/u)));
const SafeSequenceSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));

function canonicalBase64UrlBytesSchema(minBytes: number, maxBytes: number): z.ZodMiniString<string> {
  return z.string().check(z.regex(/^[A-Za-z0-9_-]+$/u), z.refine((value) => {
    if (value.length % 4 === 1) return false;
    const decoded = decodeBase64(value, 'base64url');
    return decoded.byteLength >= minBytes
      && decoded.byteLength <= maxBytes
      && encodeBase64(decoded, 'base64url') === value;
  }));
}

export const PeerApplicationEncryptionAuthorityBindingV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(PEER_APPLICATION_ENCRYPTION_VERSION_V1),
  suite: z.literal(PEER_APPLICATION_ENCRYPTION_SUITE_V1),
  flowKind: z.literal('voice_media'),
  routeKind: z.literal('server_relay'),
  authorityDigest: Sha256DigestSchema,
  accountId: z.string().check(z.minLength(1)),
  machineId: z.string().check(z.minLength(1)),
  tunnelId: z.string().check(z.minLength(1)),
  applicationKind: VoiceMediaApplicationKindV1Schema,
  applicationAttemptId: z.string().check(z.minLength(1), z.maxLength(256)),
  applicationAuthorityDigest: Sha256DigestSchema,
}));
export type PeerApplicationEncryptionAuthorityBindingV1 = z.infer<
  typeof PeerApplicationEncryptionAuthorityBindingV1Schema
>;

export const PeerApplicationEncryptionStartResponseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(PEER_APPLICATION_ENCRYPTION_VERSION_V1),
  suite: z.literal(PEER_APPLICATION_ENCRYPTION_SUITE_V1),
  recipientPublicKeyBase64Url: canonicalBase64UrlBytesSchema(32, 32),
}));
export type PeerApplicationEncryptionStartResponseV1 = z.infer<
  typeof PeerApplicationEncryptionStartResponseV1Schema
>;

const PeerApplicationEncryptedFrameBaseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(PEER_APPLICATION_ENCRYPTION_VERSION_V1),
  nonceBase64Url: canonicalBase64UrlBytesSchema(
    PEER_APPLICATION_ENCRYPTION_NONCE_BYTES_V1,
    PEER_APPLICATION_ENCRYPTION_NONCE_BYTES_V1,
  ),
  ciphertextBase64Url: canonicalBase64UrlBytesSchema(
    PEER_APPLICATION_ENCRYPTION_AUTH_TAG_BYTES_V1,
    PEER_APPLICATION_ENCRYPTION_CIPHERTEXT_MAX_BYTES_V1,
  ),
}));

export const PeerApplicationEncryptedFrameV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PeerApplicationEncryptedFrameBaseV1Schema, {
    kind: z.literal('install'),
    encryptedDataKeyEnvelopeBase64Url: z.optional(canonicalBase64UrlBytesSchema(
      1,
      PEER_APPLICATION_ENCRYPTION_DATA_KEY_ENVELOPE_MAX_BYTES_V1,
    )),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PeerApplicationEncryptedFrameBaseV1Schema, {
    kind: z.literal('data'),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PeerApplicationEncryptedFrameBaseV1Schema, {
    kind: z.literal('finish'),
  })),
]));
export type PeerApplicationEncryptedFrameV1 = z.infer<typeof PeerApplicationEncryptedFrameV1Schema>;
export type PeerApplicationEncryptionPhaseV1 = PeerApplicationEncryptedFrameV1['kind'];

const PeerApplicationEncryptionAadBaseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(PEER_APPLICATION_ENCRYPTION_VERSION_V1),
  domain: z.literal('happier.peer-application.aead'),
  suite: z.literal(PEER_APPLICATION_ENCRYPTION_SUITE_V1),
  flowKind: z.literal('voice_media'),
  authorityDigest: Sha256DigestSchema,
  accountId: z.string().check(z.minLength(1)),
  machineId: z.string().check(z.minLength(1)),
  tunnelId: z.string().check(z.minLength(1)),
  applicationAttemptId: z.string().check(z.minLength(1), z.maxLength(256)),
  applicationAuthorityDigest: Sha256DigestSchema,
  direction: z.enum(['client_to_daemon', 'daemon_to_client']),
  substreamId: z.string().check(z.minLength(1)),
  sequence: SafeSequenceSchema,
  phase: z.enum(['install', 'data', 'finish']),
}));

export const PeerApplicationEncryptionAadV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PeerApplicationEncryptionAadBaseV1Schema, {
  applicationKind: z.literal('speech_transcription'),
  streamId: z.string().check(z.minLength(1)),
  generation: z.number().check(z.int(), z.nonnegative()),
})));
export type PeerApplicationEncryptionAadV1 = z.infer<typeof PeerApplicationEncryptionAadV1Schema>;

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function createPeerApplicationAuthorityDigestV1(signedAuthority: unknown): string {
  const canonical = new TextEncoder().encode(createCanonicalJsonSigningInput(signedAuthority));
  return `sha256:${bytesToHex(sha256(canonical))}`;
}

export function createSpeechTranscriptionApplicationAuthorityDigestV1(
  applicationAttemptId: string,
): string {
  return createPeerApplicationAuthorityDigestV1({
    v: 1,
    applicationKind: 'speech_transcription',
    applicationAttemptId: z.string().check(z.minLength(1), z.maxLength(256)).parse(applicationAttemptId),
  });
}

export function createPeerApplicationEncryptionAadV1(
  input: Omit<PeerApplicationEncryptionAadV1, 'v' | 'domain' | 'suite' | 'flowKind'>,
): Uint8Array {
  const aad = PeerApplicationEncryptionAadV1Schema.parse({
    v: PEER_APPLICATION_ENCRYPTION_VERSION_V1,
    domain: 'happier.peer-application.aead',
    suite: PEER_APPLICATION_ENCRYPTION_SUITE_V1,
    flowKind: 'voice_media',
    ...input,
  });
  return new TextEncoder().encode(createCanonicalJsonSigningInput(aad));
}

export function createPeerApplicationEncryptionNonceV1(input: Readonly<{
  direction: PeerApplicationEncryptionAadV1['direction'];
  phase: PeerApplicationEncryptionPhaseV1;
  sequence: number;
}>): Uint8Array {
  const sequence = SafeSequenceSchema.parse(input.sequence);
  const out = new Uint8Array(PEER_APPLICATION_ENCRYPTION_NONCE_BYTES_V1);
  out[0] = PEER_APPLICATION_ENCRYPTION_VERSION_V1;
  out[1] = input.direction === 'client_to_daemon' ? 1 : 2;
  out[2] = input.phase === 'install' ? 0 : input.phase === 'data' ? 1 : 2;
  let remaining = BigInt(sequence);
  for (let index = out.length - 1; index >= 4; index -= 1) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

export function encodePeerApplicationEncryptedFrameV1(frame: PeerApplicationEncryptedFrameV1): Uint8Array {
  const parsed = PeerApplicationEncryptedFrameV1Schema.parse(frame);
  return new TextEncoder().encode(createCanonicalJsonSigningInput(parsed));
}

export function decodePeerApplicationEncryptedFrameV1(bytes: Uint8Array): PeerApplicationEncryptedFrameV1 | null {
  if (bytes.byteLength > PEER_APPLICATION_ENCRYPTION_CIPHERTEXT_MAX_BYTES_V1 * 2) return null;
  try {
    const parsed = PeerApplicationEncryptedFrameV1Schema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
