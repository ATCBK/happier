import { x25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';

import { BOX_BUNDLE_PUBLIC_KEY_BYTES } from './boxBundleFormat.js';

/**
 * Fixed nonzero X25519 scalar used only as a low-order probe. X25519 clamps
 * scalars, so the probe rejects the all-zero shared secrets produced by
 * low-order public keys without pulling the box encryption implementation
 * into schema-only/browser-safe consumers.
 */
const BOX_BUNDLE_LOW_ORDER_PROBE_SECRET_SCALAR = new Uint8Array([
  0x68, 0x61, 0x70, 0x70, 0x69, 0x65, 0x72, 0x2e,
  0x62, 0x6f, 0x78, 0x2e, 0x70, 0x72, 0x6f, 0x62,
  0x65, 0x2e, 0x76, 0x31, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
]);

// Public bytes only. Seal, open and schema readers share the same cryptographic
// admission result, including when a decoder creates another Uint8Array. Key
// objects are mutable, so object identity cannot establish prior validation.
const validatedPublicKeys = new Map<string, boolean>();

/** Rejects malformed X25519 encodings and low-order public keys. */
export function isValidBoxBundlePublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== BOX_BUNDLE_PUBLIC_KEY_BYTES) return false;
  const identity = bytesToHex(publicKey);
  const previous = validatedPublicKeys.get(identity);
  if (previous !== undefined) return previous;
  let valid = false;
  try {
    const probe = x25519.getSharedSecret(BOX_BUNDLE_LOW_ORDER_PROBE_SECRET_SCALAR, publicKey);
    valid = probe.some((byte) => byte !== 0);
  } catch {
    valid = false;
  }
  validatedPublicKeys.set(identity, valid);
  return valid;
}
