import * as privacyKit from "privacy-kit";
import { z } from "zod/mini";

import type { Prisma } from "@prisma/client";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * The discussion list is ordered by `(lastMessageAt DESC, id DESC)`, so its
 * keyset cursor carries exactly that tuple. It is a server-local encoding of a
 * position the client already received; it is not signed, and it grants nothing
 * on its own because every page still re-evaluates current Session access.
 */
const SessionDiscussionListCursorV1Schema = z.strictObject({
    v: z.literal(1),
    at: z.number().check(z.int()),
    id: z.string().check(z.minLength(1)),
});

export type SessionDiscussionListCursorV1 = z.infer<typeof SessionDiscussionListCursorV1Schema>;

export function encodeSessionDiscussionListCursorV1(cursor: SessionDiscussionListCursorV1): string {
    return privacyKit.encodeBase64(TEXT_ENCODER.encode(JSON.stringify(cursor)), "base64url");
}

/** A malformed cursor is rejected rather than silently restarting the page. */
export function decodeSessionDiscussionListCursorV1(raw: string): SessionDiscussionListCursorV1 | null {
    try {
        const decoded = JSON.parse(TEXT_DECODER.decode(privacyKit.decodeBase64(raw, "base64url"))) as unknown;
        const parsed = SessionDiscussionListCursorV1Schema.safeParse(decoded);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export function buildSessionDiscussionListCursorPredicate(
    cursor: SessionDiscussionListCursorV1,
): Prisma.SessionDiscussionWhereInput {
    const at = new Date(cursor.at);
    return {
        OR: [
            { lastMessageAt: { lt: at } },
            { lastMessageAt: at, id: { lt: cursor.id } },
        ],
    };
}
