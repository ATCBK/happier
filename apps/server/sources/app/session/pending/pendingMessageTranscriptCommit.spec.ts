import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import type { Tx } from "@/storage/inTx";
import { serializeSessionInputRequestEqualityIntentV1 } from "@happier-dev/protocol";

const transcriptWriter = vi.hoisted(() => ({
    validateSessionTranscriptStoredContent: vi.fn(),
    validateSessionTranscriptWriteAuthorityInTx: vi.fn(),
    writeSessionTranscriptMessageInTx: vi.fn(),
}));

// The canonical join branch registers derived-projection work through
// `afterTx`, which is only valid for transactions created by `inTx()`. The
// owner boundary under test is the join decision, not transaction plumbing,
// so collect the callbacks exactly like sessionTranscriptMutationObserver.spec.ts.
const afterTxCallbacks = vi.hoisted(() => ({ callbacks: [] as Array<() => void> }));
vi.mock("@/storage/inTx", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/storage/inTx")>();
    return {
        ...actual,
        afterTx: (_tx: unknown, callback: () => void) => afterTxCallbacks.callbacks.push(callback),
    };
});

vi.mock("@/app/session/sessionTranscriptWrite", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/session/sessionTranscriptWrite")>();
    return {
        ...actual,
        validateSessionTranscriptStoredContent: transcriptWriter.validateSessionTranscriptStoredContent,
        validateSessionTranscriptWriteAuthorityInTx: transcriptWriter.validateSessionTranscriptWriteAuthorityInTx,
        writeSessionTranscriptMessageInTx: transcriptWriter.writeSessionTranscriptMessageInTx,
    };
});

import { createSessionMessageFromPending } from "./pendingMessageTranscriptCommit";

const createdAt = new Date("2026-08-09T00:00:00.000Z");
const tx = {
    account: {
        findUnique: vi.fn(),
    },
    sessionMessage: {
        findFirst: vi.fn(),
        update: vi.fn(),
    },
} as unknown as Tx;

describe("Pending transcript commit", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        afterTxCallbacks.callbacks.splice(0);
        transcriptWriter.validateSessionTranscriptStoredContent.mockReturnValue({ ok: true });
        transcriptWriter.validateSessionTranscriptWriteAuthorityInTx.mockResolvedValue({ ok: true });
        (tx.sessionMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        (tx.account.findUnique as ReturnType<typeof vi.fn>).mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
        transcriptWriter.writeSessionTranscriptMessageInTx.mockResolvedValue({
            ok: true,
            message: {
                id: "message-1",
                seq: 1,
            sidechainId: null,
                localId: "pending-1",
                messageRole: "user",
                content: { t: "plain", v: { type: "user", text: "hello" } },
                deliveryResolution: null,
                createdAt,
                updatedAt: createdAt,
            },
        });
    });

    it("carries immutable admission evidence from Pending into the sole transcript writer", async () => {
        const inputAdmissionReceipt = {
            v: 1,
            issuer: "authenticatedAccount",
            actorAccountId: "account-1",
            sessionRelationship: "sharedEditor",
        } as const;
        const requestEqualityEvidenceV1 = {
            kind: "plainDigest",
            digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } as const;

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-1",
            content: { t: "plain", v: { type: "user", text: "hello" } },
            messageRole: "user",
            inputAdmissionReceipt,
            requestEqualityEvidenceV1,
        } as never)).resolves.toMatchObject({ ok: true, didWrite: true });

        expect(transcriptWriter.writeSessionTranscriptMessageInTx).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({
                inputAdmissionReceipt,
                requestEqualityEvidenceV1,
            }),
        );
    });

    it("derives the terminal plain digest from the complete Pending request and requested action", async () => {
        const content = {
            t: "plain" as const,
            v: {
                happierInputRequestV1: { v: 1, producer: "cli" },
                text: "hello",
            },
        };
        const requestedAction = { v: 1, kind: "send_now" } as const;
        const expectedEvidence = {
            kind: "plainDigest",
            digest: createHash("sha256")
                .update(serializeSessionInputRequestEqualityIntentV1({
                    requestEnvelope: content,
                    requestedAction,
                }), "utf8")
                .digest("base64url"),
        } as const;

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-plain-digest",
            content,
            messageRole: "user",
            pendingRequestedAction: requestedAction,
        } as never)).resolves.toMatchObject({ ok: true, didWrite: true });

        expect(transcriptWriter.writeSessionTranscriptMessageInTx).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({ requestEqualityEvidenceV1: expectedEvidence }),
        );
    });

    it("derives terminal equality from the replaced request while persisting only final authority content", async () => {
        const requestContent = {
            t: "plain" as const,
            v: {
                role: "user",
                content: { type: "text", text: "hello" },
                meta: { happierInputRequestV1: { v: 1, producer: "cli", retired: true,
                    caller: { kind: "host", retired: true }, permission: {} } },
            },
        };
        const authorityContent = {
            t: "plain" as const,
            v: {
                role: "user",
                content: { type: "text", text: "hello" },
                meta: {
                    happierInputAuthorityV1: {
                        v: 1,
                        producer: "cli",
                        caller: { kind: "host" },
                        permission: { admittedPermissionCeiling: "default" },
                    },
                },
            },
        };
        const requestedAction = { v: 1, kind: "send_now" } as const;
        const expectedEvidence = {
            kind: "plainDigest",
            digest: createHash("sha256")
                .update(serializeSessionInputRequestEqualityIntentV1({
                    requestEnvelope: requestContent,
                    requestedAction,
                }), "utf8")
                .digest("base64url"),
        } as const;

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-replaced-request",
            content: authorityContent,
            requestContentForEquality: requestContent,
            messageRole: "user",
            pendingRequestedAction: requestedAction,
        } as never)).resolves.toMatchObject({ ok: true, didWrite: true });

        expect(transcriptWriter.writeSessionTranscriptMessageInTx).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({
                content: authorityContent,
                requestEqualityEvidenceV1: expectedEvidence,
            }),
        );
    });

    it("retains the original equality evidence for settled Workflow V2 authority content", async () => {
        const authorityContent = {
            t: "plain" as const,
            v: {
                role: "user",
                content: { type: "text", text: "continue workflow" },
                meta: {
                    happierInputAuthorityV1: {
                        v: 2,
                        retired: true,
                        producer: "workflow",
                        caller: { kind: "host" },
                        workflow: {
                            purpose: "invocation",
                            runId: "workflow-run-a",
                            invocationRecordId: "invocation-a",
                            retired: true,
                        },
                        permission: { admittedPermissionCeiling: "default" },
                    },
                },
            },
        };
        const requestEqualityEvidenceV1 = {
            kind: "plainDigest",
            digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } as const;

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "workflow-v2-settled",
            content: authorityContent,
            messageRole: "user",
            pendingRequestedAction: { v: 1, kind: "enqueue" },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
            requestEqualityEvidenceV1,
        } as never)).resolves.toMatchObject({ ok: true, didWrite: true });

        expect(transcriptWriter.writeSessionTranscriptMessageInTx).toHaveBeenCalledWith(
            tx,
            expect.objectContaining({
                content: authorityContent,
                requestEqualityEvidenceV1,
            }),
        );
    });

    it("increments the private row revision when completing an existing Pending transcript row", async () => {
        const content = { t: "plain" as const, v: { type: "user", text: "hello" } };
        (tx.sessionMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "message-existing",
            seq: 1,
            sidechainId: null,
            localId: "pending-existing",
            messageRole: null,
            content,
            deliveryResolution: null,
            inputAdmissionReceipt: null,
            requestEqualityEvidenceV1: null,
            createdAt,
            updatedAt: createdAt,
        });
        (tx.sessionMessage.update as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "message-existing",
            seq: 1,
            sidechainId: null,
            localId: "pending-existing",
            messageRole: "user",
            content,
            deliveryResolution: null,
            createdAt,
            updatedAt: createdAt,
        });

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-existing",
            content,
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true, didWrite: false, didUpdate: true });

        expect(tx.sessionMessage.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "message-existing" },
            data: { messageRole: "user", rowRevision: { increment: BigInt(1) } },
        }));
    });

    it("joins a provider-written anchor without an admission identity and backfills it at settlement", async () => {
        const content = { t: "plain" as const, v: { type: "user", text: "hello" } };
        const inputAdmissionReceipt = {
            v: 1,
            issuer: "authenticatedAccount",
            actorAccountId: "account-1",
            sessionRelationship: "owner",
        } as const;
        const requestEqualityEvidenceV1 = {
            kind: "plainDigest",
            digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } as const;
        (tx.sessionMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "message-provider-anchor",
            seq: 1,
            sidechainId: null,
            localId: "pending-anchor",
            messageRole: "user",
            content,
            deliveryResolution: null,
            inputAdmissionReceipt: null,
            requestEqualityEvidenceV1: null,
            createdAt,
            updatedAt: createdAt,
        });
        (tx.sessionMessage.update as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "message-provider-anchor",
            seq: 1,
            sidechainId: null,
            localId: "pending-anchor",
            messageRole: "user",
            content,
            deliveryResolution: null,
            createdAt,
            updatedAt: createdAt,
        });

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-anchor",
            content,
            messageRole: "user",
            inputAdmissionReceipt,
            requestEqualityEvidenceV1,
        } as never)).resolves.toMatchObject({ ok: true, didWrite: false, didUpdate: true });

        expect(tx.sessionMessage.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "message-provider-anchor" },
            data: expect.objectContaining({
                inputAdmissionReceipt,
                requestEqualityEvidenceV1,
                rowRevision: { increment: BigInt(1) },
            }),
        }));
    });

    it("keeps a joined anchor holding a different admission identity as an input-admission conflict", async () => {
        const content = { t: "plain" as const, v: { type: "user", text: "hello" } };
        (tx.sessionMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "message-other-admission",
            seq: 1,
            sidechainId: null,
            localId: "pending-other-admission",
            messageRole: "user",
            content,
            deliveryResolution: null,
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedAccount",
                actorAccountId: "account-2",
                sessionRelationship: "owner",
            },
            requestEqualityEvidenceV1: null,
            createdAt,
            updatedAt: createdAt,
        });

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-other-admission",
            content,
            messageRole: "user",
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedAccount",
                actorAccountId: "account-1",
                sessionRelationship: "owner",
            },
        } as never)).resolves.toEqual({
            ok: false,
            error: "transcript-conflict",
            conflict: "input-admission",
        });

        expect(tx.sessionMessage.update).not.toHaveBeenCalled();
    });

    it("keeps established-role disagreement as a typed Pending transcript conflict", async () => {
        const content = { t: "plain" as const, v: { type: "user", text: "hello" } };
        (tx.sessionMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "message-role-conflict",
            seq: 1,
            sidechainId: null,
            localId: "pending-role-conflict",
            messageRole: "agent",
            content,
            deliveryResolution: null,
            inputAdmissionReceipt: null,
            requestEqualityEvidenceV1: null,
            createdAt,
            updatedAt: createdAt,
        });

        await expect(createSessionMessageFromPending(tx, {
            sessionId: "session-1",
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending-role-conflict",
            content,
            messageRole: "user",
        })).resolves.toEqual({
            ok: false,
            error: "transcript-conflict",
            conflict: "message-role",
        });

        expect(tx.sessionMessage.update).not.toHaveBeenCalled();
    });
});
