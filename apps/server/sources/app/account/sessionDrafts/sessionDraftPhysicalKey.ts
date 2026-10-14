import { canonicalSessionDraftAddressV2, isSessionDraftAddressV1, parseCanonicalSessionDraftAddressV2, type SessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { type SessionDraftAddressV1 } from '@happier-dev/protocol/drafts/sessionDrafts';

import { ACCOUNT_SESSION_DRAFT_KV_PREFIX } from "@/app/kv/accountScopedKv";

export { ACCOUNT_SESSION_DRAFT_KV_PREFIX } from "@/app/kv/accountScopedKv";

export const ACCOUNT_SCOPED_KV_MAX_PERSISTED_KEY_UTF8_BYTES = 191;

/**
 * One physical key owner for every draft address epoch. An address that cannot
 * be represented within the persisted key boundary returns null so the caller
 * fails closed instead of aliasing or truncating into a neighbouring row.
 */
export function sessionDraftPhysicalKey(address: SessionDraftAddressV2): string | null {
    const key = `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}${canonicalSessionDraftAddressV2(address)}`;
    return new TextEncoder().encode(key).byteLength <= ACCOUNT_SCOPED_KV_MAX_PERSISTED_KEY_UTF8_BYTES
        ? key
        : null;
}

export function parseSessionDraftPhysicalKey(key: string): SessionDraftAddressV2 | null {
    if (!key.startsWith(ACCOUNT_SESSION_DRAFT_KV_PREFIX)) return null;
    return parseCanonicalSessionDraftAddressV2(key.slice(ACCOUNT_SESSION_DRAFT_KV_PREFIX.length));
}

export function parseSessionDraftPhysicalKeyV1(key: string): SessionDraftAddressV1 | null {
    const address = parseSessionDraftPhysicalKey(key);
    return address && isSessionDraftAddressV1(address) ? address : null;
}

/**
 * Exact-Session prefix for lifecycle sweeps. The trailing separator plus the
 * encoded Session segment prevent one Session from matching a sibling whose id
 * merely starts with the same characters.
 */
export function sessionDraftPhysicalKeySessionPrefix(sessionId: string): string {
    return `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}session/${encodeURIComponent(sessionId)}/`;
}
