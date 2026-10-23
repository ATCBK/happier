import { describe, expect, it } from "vitest";

import { mapPendingMessageRow } from "./mapPendingMessageRow";
import { PendingDeliveryRecoveryV1Schema } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { SessionMessageReplyProgressV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';

describe("mapPendingMessageRow", () => {
    it.each([null, SessionMessageReplyProgressV1Schema.parse({ v: 1, mode: 'wait', disposition: 'observing' }), {}, undefined])("projects Send as new eligibility without exposing reply custody (%j)", replyProgress => {
        const now = new Date("2026-07-12T00:00:00.000Z");
        const row = {
            localId: "uncertain-input", messageRole: "user", content: { t: "plain" as const, v: "hello" },
            status: "queued" as const, deliveryState: "blocked", deliveryBlockedReason: "delivery_outcome_uncertain",
            position: 0, createdAt: now, updatedAt: now, discardedAt: null, discardedReason: null,
            authorAccountId: "account-1", replyProgress,
        };
        const mapped = mapPendingMessageRow(row);
        expect(mapped).toMatchObject({ recovery: { canSendAsNew: replyProgress === null } });
        expect(PendingDeliveryRecoveryV1Schema.parse(mapped.recovery)).toEqual({ canSendAsNew: replyProgress === null });
        expect(mapped).not.toHaveProperty('replyProgress');
    });

    it.each([
        { requestedAction: { v: 1, kind: "enqueue", retired: true }, expectedAction: { v: 1, kind: "enqueue" } },
        {
            requestedAction: { v: 1, kind: "reset_start", retired: true, reset: {
                source: { bindingKind: "account", retired: true, ref: { retired: true,
                    service: { pluginId: "happier.agent.codex", localId: "openai", retired: true }, accountId: "account" } },
                recordId: "paug_v1_abcdefgh", meterId: "weekly", retired: true,
                witness: { id: "accepted-history-entry", observedAtMs: 1000, retired: true },
            } },
            expectedAction: { v: 1, kind: "reset_start", reset: {
                source: { bindingKind: "account", ref: { service: { pluginId: "happier.agent.codex", localId: "openai" }, accountId: "account" } },
                recordId: "paug_v1_abcdefgh", meterId: "weekly",
                witness: { id: "accepted-history-entry", observedAtMs: 1000 },
            } },
        },
    ])("projects retained annotated actions as publicly queued without copying unknown fields", ({ requestedAction, expectedAction }) => {
        const now = new Date("2026-07-12T00:00:00.000Z");
        const mapped = mapPendingMessageRow({
            localId: "local-1",
            messageRole: "user",
            content: { t: "plain", v: "hello" },
            requestedAction,
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 1,
            createdAt: now,
            updatedAt: now,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "account-1",
        });
        expect(mapped).toMatchObject({
            status: "queued",
            deliveryStatus: { status: "queued" },
        });
        expect(mapped.requestedAction).toEqual(expectedAction);
        expect(mapped.requestedActionMalformed).toBeUndefined();
    });

    it.each([
        { v: 1, kind: "future_action" },
        { v: 1, kind: "reset_start", reset: {
            source: { bindingKind: "account", ref: { service: { pluginId: " ", localId: "openai" }, accountId: "account" } },
            recordId: "paug_v1_abcdefgh", meterId: "weekly", witness: { id: "accepted-history-entry", observedAtMs: 1000 },
        } },
    ])("retains an explicit malformed action as a non-executable unsupported row", requestedAction => {
        const now = new Date("2026-07-12T00:00:00.000Z");
        const mapped = mapPendingMessageRow({
            localId: "malformed-action",
            messageRole: "user",
            content: { t: "plain", v: "hello" },
            requestedAction,
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 2,
            createdAt: now,
            updatedAt: now,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "account-1",
        });

        expect(mapped).toMatchObject({
            localId: "malformed-action",
            requestedActionMalformed: true,
            deliveryStatus: { status: "blocked", reason: "unsupported_action" },
        });
        expect(mapped.requestedAction).toBeUndefined();
    });

    it("projects claimed rows as awaiting provider acceptance without adding persisted state", () => {
        const now = new Date("2026-07-12T00:00:00.000Z");
        expect(mapPendingMessageRow({
            localId: "delivering-local",
            messageRole: "user",
            content: { t: "plain", v: "hello" },
            requestedAction: { v: 1, kind: "enqueue" },
            status: "queued",
            deliveryState: "delivering",
            deliveryBlockedReason: null,
            position: 3,
            createdAt: now,
            updatedAt: now,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "account-1",
        })).toMatchObject({
            deliveryState: "delivering",
            deliveryStatus: { status: "delivering", detail: "awaiting_acceptance" },
        });
    });
});
