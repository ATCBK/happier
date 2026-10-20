import { fromByteArray, toByteArray } from 'base64-js';

export type Base64Variant = 'base64' | 'base64url';

export function readCanonicalPaddedBase64DecodedLength(input: string): number | null {
  if (input.length % 4 !== 0) return null;
  const paddingLength = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0;
  const paddingStart = input.length - paddingLength;
  // Validate in place: this hot ingress check must not copy the ciphertext or
  // run the complete payload through the RegExp engine before decoding it.
  let last = 0;
  for (let index = 0; index < paddingStart; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 65 && code <= 90) last = code - 65;
    else if (code >= 97 && code <= 122) last = code - 71;
    else if (code >= 48 && code <= 57) last = code + 4;
    else if (code === 43) last = 62;
    else if (code === 47) last = 63;
    else return null;
  }
  // Padded encodings have unused low bits in their last alphabet character.
  // Reject alternate spellings of the same bytes at the canonical boundary.
  if (paddingLength > 0) {
    if (paddingStart === 0 || (last & (paddingLength === 2 ? 15 : 3)) !== 0) return null;
  }
  return (input.length / 4) * 3 - paddingLength;
}

function normalizeBase64ForDecoding(input: string, variant: Base64Variant): string {
  if (variant === 'base64') {
    if (readCanonicalPaddedBase64DecodedLength(input) !== null) {
      return input;
    }
  }

  let normalized = input.replace(/\s+/g, '');
  if (variant === 'base64url') {
    normalized = normalized.replace(/-/g, '+').replace(/_/g, '/');
  }

  // Keep only canonical base64 alphabet characters. This matches the permissive
  // behavior of Node's Buffer base64 decoder, and prevents `base64-js` from
  // throwing on incidental whitespace or accidental invalid characters.
  normalized = normalized.replace(/[^A-Za-z0-9+/]/g, '');

  // base64 strings with length % 4 === 1 are not decodable; truncate the final
  // character to avoid throwing and align with Node's lenient decoder.
  if (normalized.length % 4 === 1) {
    normalized = normalized.slice(0, -1);
  }

  const padding = normalized.length % 4;
  if (padding) {
    normalized += '='.repeat(4 - padding);
  }
  return normalized;
}

export function encodeBase64(bytes: Uint8Array, variant: Base64Variant = 'base64'): string {
  // Preserve the view's offset/length without copying its backing storage.
  const base64 = typeof Buffer !== 'undefined'
    ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
    : fromByteArray(bytes);
  if (variant === 'base64url') {
    return base64
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }
  return base64;
}

export function decodeBase64(base64: string, variant: Base64Variant = 'base64'): Uint8Array {
  const normalized = normalizeBase64ForDecoding(base64, variant);
  return toByteArray(normalized);
}
