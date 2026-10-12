import { describe, expect, it } from "vitest";
import { TeamInvitationRowV1Schema } from "@happier-dev/protocol/teams";
import type { TeamInvitationRecord } from "./invitationLifecycle";
import { projectTeamInvitationRowV1 } from "./project";

const CREATED_AT = new Date("2026-09-06T00:00:00.000Z");
const EXPIRES_AT = new Date("2026-09-13T00:00:00.000Z");

function record(overrides: Partial<TeamInvitationRecord> = {}): TeamInvitationRecord {
    return {
        id: "inv-1",
        teamId: "team-1",
        tokenHash: new Uint8Array(32).fill(7),
        recipientEmailNormalized: null,
        role: "member",
        historyAccess: "from_membership",
        createdByAccountId: "account-1",
        acceptedAt: null,
        acceptedByAccountId: null,
        revokedAt: null,
        expiresAt: EXPIRES_AT,
        lastEmailDeliveryStatus: null,
        lastEmailDeliveryAttemptAt: null,
        createdAt: CREATED_AT,
        ...overrides,
    };
}

describe("Team invitation projection", () => {
    it("never projects the stored digest or any bearer-shaped field", () => {
        const projected = projectTeamInvitationRowV1(record(), CREATED_AT);
        expect(TeamInvitationRowV1Schema.safeParse(projected).success).toBe(true);
        const serialized = JSON.stringify(projected);
        expect(serialized).not.toContain("tokenHash");
        expect(serialized).not.toContain("token");
        expect(Object.keys(projected)).not.toContain("recipientEmailNormalized");
    });

    it("derives each state at the supplied read time rather than storing one", () => {
        expect(projectTeamInvitationRowV1(record(), CREATED_AT).state).toBe("active");
        expect(projectTeamInvitationRowV1(record(), EXPIRES_AT).state).toBe("expired");
        expect(projectTeamInvitationRowV1(record({ revokedAt: CREATED_AT }), CREATED_AT).state).toBe("revoked");
        expect(projectTeamInvitationRowV1(
            record({ acceptedAt: CREATED_AT, acceptedByAccountId: "account-2", revokedAt: CREATED_AT }),
            EXPIRES_AT,
        ).state).toBe("accepted");
    });

    it("masks a constrained recipient and leaves a transferable invitation unmasked", () => {
        expect(projectTeamInvitationRowV1(
            record({ recipientEmailNormalized: "person@example.test" }),
            CREATED_AT,
        ).recipientEmailMask).toBe("p•••@example.test");
        expect(projectTeamInvitationRowV1(record(), CREATED_AT).recipientEmailMask).toBeNull();
    });

    it("reports the two coarse delivery fields only as one complete recorded attempt", () => {
        expect(projectTeamInvitationRowV1(record(), CREATED_AT).lastEmailDelivery).toBeNull();
        expect(projectTeamInvitationRowV1(
            record({ lastEmailDeliveryStatus: "sent", lastEmailDeliveryAttemptAt: CREATED_AT }),
            CREATED_AT,
        ).lastEmailDelivery).toEqual({ status: "sent", attemptedAt: CREATED_AT.getTime() });
        // A half-written pair is unknown, not a claim that mail was submitted.
        expect(projectTeamInvitationRowV1(
            record({ lastEmailDeliveryStatus: "sent", lastEmailDeliveryAttemptAt: null }),
            CREATED_AT,
        ).lastEmailDelivery).toBeNull();
    });

    it("refuses to project an invitation whose stored role is not admissible", () => {
        expect(() => projectTeamInvitationRowV1(record({ role: "owner" }), CREATED_AT)).toThrow();
    });

    it("projects timestamps as epoch milliseconds so clients need no server timezone", () => {
        const projected = projectTeamInvitationRowV1(record(), CREATED_AT);
        expect(projected.createdAt).toBe(CREATED_AT.getTime());
        expect(projected.expiresAt).toBe(EXPIRES_AT.getTime());
    });

    it("publishes the terminal instant with acceptance taking precedence over revocation and expiry", () => {
        expect(projectTeamInvitationRowV1(record(), CREATED_AT)).toMatchObject({ finishedAt: null });
        expect(projectTeamInvitationRowV1(record(), EXPIRES_AT)).toMatchObject({ finishedAt: EXPIRES_AT.getTime() });
        expect(projectTeamInvitationRowV1(record({ revokedAt: CREATED_AT }), EXPIRES_AT))
            .toMatchObject({ finishedAt: CREATED_AT.getTime() });
        expect(projectTeamInvitationRowV1(record({ acceptedAt: CREATED_AT, revokedAt: EXPIRES_AT }), EXPIRES_AT))
            .toMatchObject({ finishedAt: CREATED_AT.getTime() });
    });

    it("projects the accepting Account through the shared neutral display-profile owner", () => {
        const person = { id: "account-2", name: "Ada Lovelace", firstName: "Old", lastName: "Identity", username: null, avatar: null };
        const projected = projectTeamInvitationRowV1(record({
            acceptedAt: CREATED_AT, acceptedByAccountId: person.id,
        }), EXPIRES_AT, person);
        expect(projected).toMatchObject({
            finishedByAccount: { name: "Ada Lovelace", firstName: "Ada Lovelace", lastName: null, username: null, avatarUrl: null },
        });
        expect(projectTeamInvitationRowV1(record(), CREATED_AT, person)).toMatchObject({ finishedByAccount: null });
    });
});
