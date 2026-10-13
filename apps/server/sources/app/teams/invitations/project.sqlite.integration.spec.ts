import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createTeamInvitationForActorInTx } from "./invitationService";
import { ACCOUNT_DISPLAY_PROFILE_SELECT, type AccountDisplayProfileRow } from "@/app/account/profile/accountDisplayProfile";
import { TeamInvitationRowV1Schema } from "@happier-dev/protocol/teams";
import type { TeamInvitationRecord } from "./invitationLifecycle";
import { projectTeamInvitationRowV1 as produceTeamInvitationRowV1 } from "./project";

// Every real producer result, including terminal and half-written delivery rows,
// must be readable by the strict wire consumer before its behavior is asserted.
function projectTeamInvitationRowV1(...args: Parameters<typeof produceTeamInvitationRowV1>) {
    return TeamInvitationRowV1Schema.parse(produceTeamInvitationRowV1(...args));
}

const CREATED_AT = new Date("2026-09-06T00:00:00.000Z");
const EXPIRES_AT = new Date("2026-09-13T00:00:00.000Z");

let harness: LightSqliteHarness;
let producedRecord: TeamInvitationRecord;
let acceptingPerson: AccountDisplayProfileRow;

beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: "happier-invitation-projection-", initAuth: false });
    const creator = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
    acceptingPerson = await db.account.create({
        data: { publicKey: crypto.randomUUID(), encryptionMode: "plain", name: "Ada Lovelace", firstName: "Old", lastName: "Identity" },
        select: ACCOUNT_DISPLAY_PROFILE_SELECT,
    });
    const team = await db.team.create({ data: { name: "Invitation projection" } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: creator.id, role: "owner" } });
    const created = await inTx(tx => createTeamInvitationForActorInTx(tx, {
        teamId: team.id, actorAccountId: creator.id, role: "member", historyAccess: "from_membership",
        recipientEmailNormalized: null, emailDeliveryAvailable: true, requestKey: crypto.randomUUID(),
    }));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    producedRecord = await db.teamInvitation.findUniqueOrThrow({ where: { id: created.value.invitation.id } });
}, 120_000);

afterAll(async () => { if (harness) await harness.close(); });

// Start from the actual creation writer's stored row. Controlled timestamps and
// corrupt/half-written storage fields exercise projection edges without copying
// the internal persistence shape into a parallel fixture.
function record(overrides: Partial<TeamInvitationRecord> = {}): TeamInvitationRecord {
    return { ...producedRecord, createdAt: CREATED_AT, expiresAt: EXPIRES_AT, ...overrides };
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
        const person = acceptingPerson;
        const projected = projectTeamInvitationRowV1(record({
            acceptedAt: CREATED_AT, acceptedByAccountId: person.id,
        }), EXPIRES_AT, person);
        expect(projected).toMatchObject({
            finishedByAccount: { name: "Ada Lovelace", firstName: "Ada Lovelace", lastName: null, username: null, avatarUrl: null },
        });
        expect(projectTeamInvitationRowV1(record(), CREATED_AT, person)).toMatchObject({ finishedByAccount: null });
    });
});
