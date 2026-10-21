import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

export type ConnectedAccountAccessTokenFingerprint = `sha256:${string}`;

/** Existing bounded runtime token proof; distinct from request-auth's full digest. */
export function computeConnectedAccountAccessTokenFingerprint(
  accessToken: string,
): ConnectedAccountAccessTokenFingerprint {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(accessToken))).slice(0, 8)}`;
}

export function normalizeConnectedAccountAccessTokenFingerprint(
  value: unknown,
): ConnectedAccountAccessTokenFingerprint | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^sha256:[a-f0-9]{8}$/u.test(text)
    ? text as ConnectedAccountAccessTokenFingerprint
    : null;
}
