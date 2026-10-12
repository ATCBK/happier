import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { applySessionTurnMutation } from "./sessionWriteService";

describe("terminal session turns clear pending request projection on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-turn-pending-requests-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    beforeEach(() => harness.resetEnv());
    afterAll(async () => harness.close());

    const readPendingRequestProjection = async (sessionId: string) => await db.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            pendingRequestObservedAt: true,
        },
    });

    it("keeps pending requests while the latest turn runs and clears them when it ends", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const pendingRequestObservedAt = new Date(150);
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `tag-${randomUUID()}`,
                metadata: "{}",
                // A best-effort agent-state write left these behind; the durable turn end must not keep them alive.
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt,
            },
        });
        const turnId = `turn-${randomUUID()}`;

        await expect(applySessionTurnMutation({
            actorUserId: account.id,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: `begin-${randomUUID()}`,
                action: "begin",
                turnId,
                observedAt: 100,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true, latestTurnStatus: "in_progress" });
        await expect(readPendingRequestProjection(session.id)).resolves.toEqual({
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt,
        });

        await expect(applySessionTurnMutation({
            actorUserId: account.id,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: `complete-${randomUUID()}`,
                action: "complete",
                turnId,
                observedAt: 200,
            },
        })).resolves.toMatchObject({
            ok: true,
            didApply: true,
            latestTurnStatus: "completed",
            pendingRequestProjection: {
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: null,
            },
        });
        await expect(readPendingRequestProjection(session.id)).resolves.toEqual({
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: null,
        });
    });
});
