import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { sessionDraftPhysicalKey } from "@/app/account/sessionDrafts/sessionDraftPhysicalKey";
import { captureSessionAccessMembershipImpactsInTx, applySessionAccessMembershipImpactsInTx } from "./sessionAccessMembershipImpact";

describe("Membership Session access effects (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-membership-impact-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
            },
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const member = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Membership impact" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Group", nameKey: "group" } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain", currentStorageState: "hosted",
            responsibleAccountId: member.id,
            teamGrants: { create: { teamId: team.id, accessLevel: "edit", effectiveAt: new Date() } },
            groupGrants: { create: { teamGroupId: group.id, accessLevel: "view", effectiveAt: new Date() } },
        } });
        const key = sessionDraftPhysicalKey({ kind: "session", sessionId: session.id });
        if (!key) throw new Error("expected Session draft key");
        await db.userKVStore.create({ data: { accountId: member.id, key, value: new Uint8Array([1]), version: 1 } });
        return { owner, member, team, membership, group, session, key };
    }

    it("preserves a readable draft and responsibility on role downgrade, then clears them after final Group loss", async () => {
        const f = await fixture();
        await inTx(async tx => {
            const impacts = await captureSessionAccessMembershipImpactsInTx(tx, { accountIds: [f.member.id], changes: [{ kind: "teamRole", teamId: f.team.id }] });
            await tx.teamMembership.update({ where: { id: f.membership.id }, data: { role: "guest" } });
            await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
        });
        expect(await db.session.findUnique({ where: { id: f.session.id }, select: { responsibleAccountId: true } })).toEqual({ responsibleAccountId: f.member.id });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: f.member.id, key: f.key } }, select: { value: true } })).toEqual({ value: new Uint8Array([1]) });
        expect(await db.accountChange.count({ where: { accountId: f.member.id, entityId: f.session.id, kind: "session" } })).toBe(1);
        expect(await db.accountChange.count({ where: { entityId: f.session.id, kind: "share" } })).toBe(0);

        await inTx(async tx => {
            const impacts = await captureSessionAccessMembershipImpactsInTx(tx, { accountIds: [f.member.id], changes: [{ kind: "teamGroupMembership", teamId: f.team.id, teamGroupIds: [f.group.id] }] });
            await tx.teamGroupMembership.deleteMany({ where: { teamGroupId: f.group.id, teamMembershipId: f.membership.id } });
            await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
        });
        expect(await db.session.findUnique({ where: { id: f.session.id }, select: { responsibleAccountId: true } })).toEqual({ responsibleAccountId: null });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: f.member.id, key: f.key } }, select: { value: true } })).toEqual({ value: null });
        expect(await db.accountChange.count({ where: { entityId: f.session.id, kind: "share" } })).toBe(0);
    });

    it("does not invalidate access after removal of a weaker overlapping membership", async () => {
        const f = await fixture();
        await db.sessionShare.create({ data: { sessionId: f.session.id, sharedByUserId: f.owner.id, sharedWithUserId: f.member.id, accessLevel: "admin" } });
        await inTx(async tx => {
            const impacts = await captureSessionAccessMembershipImpactsInTx(tx, { accountIds: [f.member.id], changes: [{ kind: "teamMembership", teamId: f.team.id }] });
            await tx.teamMembership.delete({ where: { id: f.membership.id } });
            await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
        });
        // The decisive direct access survives, while the audience context loses
        // its Team relationship and therefore needs a projection refresh.
        expect(await db.accountChange.count({ where: { entityId: f.session.id } })).toBe(1);
        expect(await db.session.findUnique({ where: { id: f.session.id }, select: { responsibleAccountId: true } })).toEqual({ responsibleAccountId: f.member.id });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: f.member.id, key: f.key } }, select: { value: true } })).toEqual({ value: new Uint8Array([1]) });
    });

    it("restores Group access without enrolling Follow and preserves explicit unfollow", async () => {
        const f = await fixture();
        await db.account.update({ where: { id: f.member.id }, data: { sessionAutoFollowTeam: false, sessionAutoFollowGroup: true } });
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { status: "suspended" } });
        const reactivate = () => inTx(async tx => {
            const impacts = await captureSessionAccessMembershipImpactsInTx(tx, { accountIds: [f.member.id], changes: [{ kind: "teamMembership", teamId: f.team.id }] });
            await tx.teamMembership.update({ where: { id: f.membership.id }, data: { status: "active" } });
            await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
        });
        await reactivate();
        const where = { accountId_sessionId: { accountId: f.member.id, sessionId: f.session.id } };
        expect(await db.accountSessionFollow.findUnique({ where })).toBeNull();
        expect(await db.accountSessionReadState.findUnique({ where })).toBeNull();
        await db.accountSessionFollow.create({ data: {
            accountId: f.member.id, sessionId: f.session.id, following: false, notificationLevel: "none",
        } });
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { status: "suspended" } });
        await reactivate();
        expect(await db.accountSessionFollow.findUnique({ where })).toMatchObject({ following: false, notificationLevel: "none" });
    });

    it("rolls back access effects with the native mutation", async () => {
        const f = await fixture();
        await expect(inTx(async tx => {
            const impacts = await captureSessionAccessMembershipImpactsInTx(tx, { accountIds: [f.member.id], changes: [{ kind: "teamMembership", teamId: f.team.id }] });
            await tx.teamMembership.delete({ where: { id: f.membership.id } });
            await applySessionAccessMembershipImpactsInTx(tx, { impacts: impacts.values() });
            throw new Error("native transition aborted");
        })).rejects.toThrow("native transition aborted");
        expect(await db.teamMembership.findUnique({ where: { id: f.membership.id } })).not.toBeNull();
        expect(await db.accountChange.count({ where: { entityId: f.session.id } })).toBe(0);
        expect(await db.session.findUnique({ where: { id: f.session.id }, select: { responsibleAccountId: true } })).toEqual({ responsibleAccountId: f.member.id });
        expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: f.member.id, key: f.key } }, select: { value: true } })).toEqual({ value: new Uint8Array([1]) });
    });
});
