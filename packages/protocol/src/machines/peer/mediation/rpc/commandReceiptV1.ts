import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { z } from 'zod/mini';

import { createCanonicalJsonSigningInput } from '../../../../crypto/canonicalJson.js';

export const PeerMachineRpcCommandReceiptIssuerV1Schema = lazyZodSchema(() => z.enum(['ui', 'daemon']));

export const PeerMachineRpcCommandReceiptRequestV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    issuer: PeerMachineRpcCommandReceiptIssuerV1Schema,
    issuedAtMs: z.number().check(z.int(), z.nonnegative()),
    requestHash: z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/)),
    replayKey: z.string().check(z.minLength(1)),
    resultHash: z.optional(z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/))),
  }));

export const PeerMachineRpcCommandReceiptSuccessV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PeerMachineRpcCommandReceiptRequestV1Schema, {
  issuer: z.literal('daemon'),
  resultHash: z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/)),
})));

export type PeerMachineRpcCommandReceiptIssuerV1 = z.infer<typeof PeerMachineRpcCommandReceiptIssuerV1Schema>;
export type PeerMachineRpcCommandReceiptRequestV1 = z.infer<typeof PeerMachineRpcCommandReceiptRequestV1Schema>;
export type PeerMachineRpcCommandReceiptSuccessV1 = z.infer<typeof PeerMachineRpcCommandReceiptSuccessV1Schema>;

function computeSha256Digest(value: string): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(value)))}`;
}

export function createPeerMachineRpcRequestHashV1(input: Readonly<{
  method: string;
  params: unknown;
  grantId: string;
  endpointFingerprint: string;
  replayKey: string;
}>): string {
  return computeSha256Digest(createCanonicalJsonSigningInput({
    v: 1,
    method: input.method,
    params: input.params,
    grantId: input.grantId,
    endpointFingerprint: input.endpointFingerprint,
    replayKey: input.replayKey,
  }));
}

export function createPeerMachineRpcResultHashV1(result: unknown): string {
  return computeSha256Digest(createCanonicalJsonSigningInput({
    v: 1,
    result,
  }));
}
