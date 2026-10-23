import { z } from 'zod/mini';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { decryptString, encryptString } from '@/modules/encrypt';

const sealedCursorSchema = z.strictObject({ t: z.literal('sealed_v1'), c: z.string().check(z.minLength(1)) });

/** Candidate positions may name unreadable sources; only the server opens them. */
export function sealSessionFollowListCursor(scope: string, cursor: string): string {
    return JSON.stringify({ t: 'sealed_v1', c: encodeBase64(encryptString(['follow-list', 'v1', scope], cursor)) });
}

/** Retain existing V1 cursor inputs; a malformed sealed envelope never falls back to plain. */
export function openSessionFollowListCursor(scope: string, cursor?: string): string | undefined {
    if (cursor === undefined) return undefined;
    const value: unknown = JSON.parse(cursor);
    if (value !== null && typeof value === 'object' && 't' in value) {
        const sealed = sealedCursorSchema.parse(value);
        return decryptString(['follow-list', 'v1', scope], decodeBase64(sealed.c));
    }
    // The Protocol keyset owner validates this closed legacy V1 shape and its scope.
    return cursor;
}
