import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";

import { db } from "@/storage/db";
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

const emitUpdate = vi.fn();
vi.mock("@/app/events/eventRouter", async () => {
    const actual = await vi.importActual<
        typeof import("@/app/events/eventRouter")
    >("@/app/events/eventRouter");
    return {
        ...actual,
        eventRouter: {
            ...actual.eventRouter,
            emitUpdate,
        },
    };
});

describe("deleteOwnedSession stored-content compatibility (SQLite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "session-delete-compatibility-",
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(async () => {
        emitUpdate.mockReset();
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
        await db.account.create({ data: { id: "owner" } });
    });

    it("allows a caller to delete layout 1 without interpreting its content", async () => {
        await db.session.create({
            data: {
                id: "layout-1",
                tag: "layout-1",
                accountId: "owner",
                metadata: "shared",
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify({
                    t: "plain",
                    v: { path: "/private" },
                }),
            },
        });

        const { deleteOwnedSession } = await import(
            "./deleteOwnedSession"
        );
        const result = await deleteOwnedSession({
            sessionId: "layout-1",
            ownerAccountId: "owner",
            reason: "user_request",
        });

        expect(result).toEqual({ ok: true });
        expect(await db.session.findUnique({
            where: { id: "layout-1" },
        })).toBeNull();
        expect(await db.accountChange.findMany({
            where: { accountId: "owner" },
            select: {
                kind: true,
                entityId: true,
                hint: true,
            },
        })).toEqual([{
            kind: "session",
            entityId: "layout-1",
            hint: { v: 1, lifecycle: "deleted" },
        }]);
        expect(emitUpdate).toHaveBeenCalled();
    });

    it("preserves released layout-0 deletion for a legacy caller", async () => {
        await db.session.create({
            data: {
                id: "layout-0",
                tag: "layout-0",
                accountId: "owner",
                metadata: "legacy-ciphertext",
                metadataLayoutVersion: 0,
            },
        });

        const { deleteOwnedSession } = await import(
            "./deleteOwnedSession"
        );
        const result = await deleteOwnedSession({
            sessionId: "layout-0",
            ownerAccountId: "owner",
            reason: "user_request",
        });

        expect(result).toEqual({ ok: true });
        expect(await db.session.findUnique({
            where: { id: "layout-0" },
        })).toBeNull();
        expect(await db.accountChange.count({
            where: { accountId: "owner", kind: "session" },
        })).toBe(1);
    });

    it("tombstones the owner's and collaborator's Session and Run drafts while preserving a sibling Session", async () => {
        const { mutateSessionDraft, readSessionDraft } = await import('@/app/account/sessionDrafts/sessionDraftService');
        const { sessionDraftPhysicalKey } = await import('@/app/account/sessionDrafts/sessionDraftPhysicalKey');
        const { deleteOwnedSession } = await import('./deleteOwnedSession');
        const authentication = { env: process.env, authority: 'present_user' as const, authenticationEvidence: undefined };
        await db.account.create({ data: { id: 'collaborator' } });
        await db.session.createMany({ data: ['draft-parent', 'draft-parent-sibling'].map(id => ({
            id, tag: id, accountId: 'owner', metadata: '{}', encryptionMode: 'e2ee',
        })) });
        await db.sessionShare.create({ data: {
            sessionId: 'draft-parent', sharedWithUserId: 'collaborator', sharedByUserId: 'owner', accessLevel: 'view',
        } });
        const addresses = [
            { kind: 'session', sessionId: 'draft-parent' },
            { kind: 'run', sessionId: 'draft-parent', runId: 'run-a' },
            { kind: 'session', sessionId: 'draft-parent-sibling' },
        ] as const;
        for (const accountId of ['owner', 'collaborator']) {
            for (const address of addresses) {
                if (accountId === 'collaborator' && address.sessionId !== 'draft-parent') continue;
                expect(await mutateSessionDraft({ accountId, address, expectedRevision: 'absent',
                    content: { t: 'encrypted', c: 'opaque-draft-content', v: 2 }, authentication,
                })).toMatchObject({ status: 'updated', record: { revision: 0 } });
            }
        }

        await expect(deleteOwnedSession({ sessionId: 'draft-parent', ownerAccountId: 'owner', reason: 'user_request' }))
            .resolves.toEqual({ ok: true });
        for (const accountId of ['owner', 'collaborator']) {
            for (const address of addresses.slice(0, 2)) {
                const key = sessionDraftPhysicalKey(address);
                if (!key) throw new Error('Expected a canonical draft key');
                expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId, key } },
                    select: { value: true, version: true },
                })).toEqual({ value: null, version: 1 });
                expect(await readSessionDraft({ accountId, address, authentication })).toEqual({ status: 'absent' });
            }
        }
        expect(await readSessionDraft({ accountId: 'owner', address: addresses[2], authentication }))
            .toMatchObject({ status: 'present', record: { revision: 0 } });
        expect(await mutateSessionDraft({ accountId: 'owner', address: addresses[0], expectedRevision: 1,
            content: null, authentication,
        })).toEqual({ status: 'sessionUnavailable' });
    });

    it("invalidates a surviving Follow destination when deleting its source Session", async () => {
        await db.session.createMany({ data: [{
            id: "follow-source-delete",
            tag: "follow-source-delete",
            accountId: "owner",
            metadata: "{}",
            metadataLayoutVersion: 1,
        }, {
            id: "follow-destination-survives",
            tag: "follow-destination-survives",
            accountId: "owner",
            metadata: "{}",
            metadataLayoutVersion: 1,
        }] });
        await db.sessionFollowEdge.create({ data: {
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: 'follow-source-delete' }),
            sourceSessionId: "follow-source-delete",
            destinationSessionId: "follow-destination-survives",
            policyJson: '{"preset":"quiet"}',
        } });

        const { deleteOwnedSession } = await import("./deleteOwnedSession");
        await expect(deleteOwnedSession({
            sessionId: "follow-source-delete",
            ownerAccountId: "owner",
            reason: "user_request",
        })).resolves.toEqual({ ok: true });

        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: "owner",
            kind: "session",
            entityId: "follow-destination-survives",
        } } })).not.toBeNull();
    });

    it("rolls the durable deletion hint back when the physical delete loses its condition", async () => {
        await db.session.create({
            data: {
                id: "delete-condition-lost",
                tag: "delete-condition-lost",
                accountId: "owner",
                metadata: "legacy-ciphertext",
                metadataLayoutVersion: 0,
            },
        });
        await db.session.create({ data: {
            id: "delete-condition-destination",
            tag: "delete-condition-destination",
            accountId: "owner",
            metadata: "{}",
            metadataLayoutVersion: 1,
        } });
        await db.sessionFollowEdge.create({ data: {
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: 'delete-condition-lost' }),
            sourceSessionId: "delete-condition-lost",
            destinationSessionId: "delete-condition-destination",
            policyJson: '{"preset":"quiet"}',
        } });

        const { deleteOwnedSession } = await import(
            "./deleteOwnedSession"
        );
        const result = await deleteOwnedSession({
            sessionId: "delete-condition-lost",
            reason: "retention_policy",
            // The deletion owner increments seq at its writer boundary. Keeping
            // the pre-claim value in the final predicate deterministically
            // forces the final physical delete to lose its condition after the
            // AccountChange write, exercising the real transaction rollback.
            sessionWhereGuard: { seq: 0 },
        });

        expect(result).toEqual({ ok: false, error: "conflict" });
        expect(await db.session.findUnique({
            where: { id: "delete-condition-lost" },
            select: { seq: true },
        })).toEqual({ seq: 0 });
        expect(await db.accountChange.count({
            where: {
                accountId: "owner",
                kind: "session",
                entityId: "delete-condition-lost",
            },
        })).toBe(0);
        expect(await db.accountChange.count({
            where: {
                accountId: "owner",
                kind: "session",
                entityId: "delete-condition-destination",
            },
        })).toBe(0);
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
