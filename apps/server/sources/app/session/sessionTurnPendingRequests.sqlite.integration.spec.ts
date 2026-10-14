import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { applySessionTurnMutation, updateSessionAgentState } from "./sessionWriteService";

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

    it.each([
        ["complete", "completed"],
        ["cancel", "cancelled"],
        ["end_session", "cancelled"],
    ] as const)("keeps pending requests while running and clears them on %s", async (action, status) => {
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
                action,
                turnId,
                observedAt: 200,
            },
        })).resolves.toMatchObject({
            ok: true,
            didApply: true,
            latestTurnStatus: status,
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
    it("preserves newer pending requests when enriching a completed latest turn", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const session = await db.session.create({
            data: { accountId: account.id, tag: `tag-${randomUUID()}`, metadata: "{}" },
        });
        const turnId = `turn-${randomUUID()}`;
        for (const [action, observedAt] of [["begin", 100], ["complete", 200]] as const) {
            await expect(applySessionTurnMutation({
                actorUserId: account.id,
                mutation: { v: 1, sessionId: session.id, mutationId: randomUUID(), action, turnId, observedAt },
            })).resolves.toMatchObject({ ok: true, didApply: true });
        }
        await expect(updateSessionAgentState({
            actorUserId: account.id,
            sessionId: session.id,
            expectedVersion: 0,
            agentStateCiphertext: "{}",
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 1,
        })).resolves.toMatchObject({ ok: true });
        const pending = await readPendingRequestProjection(session.id);
        const result = await applySessionTurnMutation({
            actorUserId: account.id,
            mutation: {
                v: 1, sessionId: session.id, mutationId: randomUUID(),
                action: "append_transcript_anchors", turnId, observedAt: 300,
                transcriptAnchors: { assistantMessageSeqs: [1] },
            },
        });
        expect(result).toMatchObject({ ok: true, didApply: true });
        expect(result).not.toHaveProperty("pendingRequestProjection");
        await expect(readPendingRequestProjection(session.id)).resolves.toEqual(pending);
    });

});
