import * as crypto from "crypto";
import { TEAM_INVITATION_TOKEN_LENGTH, TeamInvitationTokenV1Schema } from '@happier-dev/protocol/teams/invitation';
import { createRandomAlphanumeric } from "@/utils/keys/createRandomAlphanumeric";

/**
 * The single Team invitation token codec.
 *
 * Minting reuses the server's existing cryptographic alphanumeric key owner rather
 * than adding a second token codec or dependency. Only the SHA-256 digest is ever
 * persisted, so a lost create response can never be answered from storage: the
 * recovery path is an explicit reissue, not a token vault.
 */

export function mintTeamInvitationToken(): string {
    return createRandomAlphanumeric(TEAM_INVITATION_TOKEN_LENGTH);
}

/**
 * Fails closed on a malformed bearer so an oversized or structurally invalid input
 * can never be turned into a digest and probed against stored invitations.
 */
export function digestTeamInvitationToken(token: string): Buffer {
    const parsed = TeamInvitationTokenV1Schema.parse(token);
    return crypto.createHash("sha256").update(parsed, "utf8").digest();
}

/**
 * The lookup-path variant: an attacker-supplied bearer that cannot be a real token
 * is a `not_found`/unavailable outcome, not a 500.
 */
export function tryDigestTeamInvitationToken(token: unknown): Buffer | null {
    const parsed = TeamInvitationTokenV1Schema.safeParse(token);
    if (!parsed.success) return null;
    return crypto.createHash("sha256").update(parsed.data, "utf8").digest();
}
