import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { afterTx, inTx, transactionResult } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { markAccountChanged, markAccountsChanged, markSessionAccountsChanged, type MarkAccountChangedParams } from "./markAccountChanged";

describe("terminal AccountChange publication on SQLite", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-publication-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    afterEach(() => { eventRouter.clearIo(); });
    afterAll(async () => { await harness?.close(); });

    it("retains queued Session and Machine removal changes after domain work deletes their rows", async () => {
        const account = await db.account.create({ data: { publicKey: "deleted-publication-resources" } });
        const pointSession = await db.session.create({ data: { accountId: account.id, tag: "deleted-point", metadata: "{}" } });
        const batchSession = await db.session.create({ data: { accountId: account.id, tag: "deleted-batch", metadata: "{}" } });
        const pointMachine = await db.machine.create({ data: { id: "deleted-point-machine", accountId: account.id, metadata: "{}" } });
        const batchMachine = await db.machine.create({ data: { id: "deleted-batch-machine", accountId: account.id, metadata: "{}" } });
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });

        const changes = await inTx(async tx => {
            const pointSessionChange = await markAccountChanged(tx, {
                accountId: account.id, kind: "session", entityId: pointSession.id, hint: { removed: true },
            });
            const [batchSessionChange] = await markSessionAccountsChanged(tx, new Map([[batchSession.id, [account.id]]]));
            const pointMachineChange = await markAccountChanged(tx, {
                accountId: account.id, kind: "machine", entityId: pointMachine.id, hint: { removed: true },
            });
            const [batchMachineChange] = await markAccountsChanged(tx, {
                accountIds: [account.id], kind: "machine", entityId: batchMachine.id, hint: { removed: true, batch: true },
            });
            await tx.session.deleteMany({ where: { id: { in: [pointSession.id, batchSession.id] } } });
            await tx.machine.deleteMany({ where: { id: { in: [pointMachine.id, batchMachine.id] } } });
            expect(emit).not.toHaveBeenCalled();
            return transactionResult(() => [
                { kind: "session", entityId: pointSession.id, cursor: pointSessionChange.resolveCursor(), hint: { removed: true } },
                { kind: "session", entityId: batchSession.id, cursor: batchSessionChange.resolveCursor(), hint: null },
                { kind: "machine", entityId: pointMachine.id, cursor: pointMachineChange.resolveCursor(), hint: { removed: true } },
                { kind: "machine", entityId: batchMachine.id, cursor: batchMachineChange.resolveCursor(), hint: { removed: true, batch: true } },
            ]);
        });

        expect(changes.map(change => change.cursor).sort((left, right) => left - right)).toEqual([1, 2, 3, 4]);
        await expect(db.accountChange.findMany({ where: { accountId: account.id }, orderBy: { cursor: "asc" },
            select: { kind: true, entityId: true, cursor: true, hint: true,
                sessionId: true, machineId: true, artifactId: true, accountPetPackageId: true } }))
            .resolves.toEqual(changes.map(change => ({ ...change,
                sessionId: null, machineId: null, artifactId: null, accountPetPackageId: null,
            })).sort((left, right) => left.cursor - right.cursor));
        expect(emit).toHaveBeenCalledWith("update", expect.objectContaining({ seq: 4, body: { t: "account-change" } }));
    });

    it("captures the declared Session audience and entities before caller-owned maps and arrays change", async () => {
        const owner = await db.account.create({ data: { publicKey: "captured-session-owner" } });
        const later = await db.account.create({ data: { publicKey: "later-session-recipient" } });
        const original = await db.session.create({ data: { accountId: owner.id, tag: "captured", metadata: "{}" } });
        const replacement = await db.session.create({ data: { accountId: owner.id, tag: "replacement", metadata: "{}" } });

        const publications = await inTx(async tx => {
            const accountIds = [owner.id];
            const recipients = new Map([[original.id, accountIds]]);
            const publications = await markSessionAccountsChanged(tx, recipients);
            accountIds.push(later.id);
            recipients.delete(original.id);
            recipients.set(replacement.id, [later.id]);
            return publications;
        });

        expect(publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() })))
            .toEqual([{ accountId: owner.id, cursor: 1 }]);
        await expect(db.accountChange.findMany({ where: { accountId: { in: [owner.id, later.id] } },
            select: { accountId: true, entityId: true, sessionId: true } })).resolves.toEqual([{
            accountId: owner.id, entityId: original.id, sessionId: original.id,
        }]);
        await expect(db.account.findUniqueOrThrow({ where: { id: later.id }, select: { seq: true } }))
            .resolves.toEqual({ seq: 0 });
    });

    it("captures point publication parameters and hints when the intent is recorded", async () => {
        const owner = await db.account.create({ data: { publicKey: "captured-point-owner" } });
        const later = await db.account.create({ data: { publicKey: "later-point-recipient" } });
        const publication = await inTx(async tx => {
            const hint = { keys: ["original"] };
            const params: MarkAccountChangedParams = { accountId: owner.id, kind: "account", entityId: "original", hint };
            const publication = await markAccountChanged(tx, params);
            params.accountId = later.id;
            params.entityId = "replacement";
            hint.keys[0] = "replacement";
            return publication;
        });

        expect(publication.accountId).toBe(owner.id);
        expect(publication.resolveCursor()).toBe(1);
        await expect(db.accountChange.findMany({ where: { accountId: { in: [owner.id, later.id] } },
            select: { accountId: true, entityId: true, hint: true } })).resolves.toEqual([{
            accountId: owner.id, entityId: "original", hint: { keys: ["original"] },
        }]);
        await expect(db.account.findUniqueOrThrow({ where: { id: later.id }, select: { seq: true } }))
            .resolves.toEqual({ seq: 0 });
    });

    it("defers allocation until domain work finishes and preserves queued full Collection invalidation", async () => {
        const account = await db.account.create({ data: { publicKey: "queued-collection-publication" } });
        const pluginId = "example.contract";
        const collectionId = "queued";
        const entityId = `pluginDomain/${pluginId}/data-collection/${collectionId}`;
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        let afterCommitCursor: number | undefined;

        const result = await inTx(async tx => {
            const full = await markAccountChanged(tx, {
                accountId: account.id, kind: "pluginDomain", entityId,
                hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                    contractDigest: "a".repeat(43), revision: 1, full: true },
            });
            const exact = await markAccountChanged(tx, {
                accountId: account.id, kind: "pluginDomain", entityId,
                hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                    contractDigest: "b".repeat(43), revision: 2, rowIds: ["task-1"] },
            });
            expect(() => exact.resolveCursor()).toThrow();
            expect(await tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 0 });
            expect(await tx.accountChange.findMany({ where: { accountId: account.id } })).toEqual([]);
            expect(emit).not.toHaveBeenCalled();
            afterTx(tx, () => { afterCommitCursor = exact.resolveCursor(); });
            return transactionResult(() => ({ fullCursor: full.resolveCursor(), cursor: exact.resolveCursor() }));
        });

        expect(result.cursor).toBeGreaterThanOrEqual(result.fullCursor);
        expect(afterCommitCursor).toBe(result.cursor);
        expect(emit).toHaveBeenCalled();
        await expect(db.accountChange.findMany({ where: { accountId: account.id },
            select: { entityId: true, cursor: true, hint: true } })).resolves.toEqual([{
            entityId, cursor: result.cursor,
            hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                contractDigest: "b".repeat(43), revision: 2, full: true },
        }]);
    });

    it("rolls back terminal allocation and suppresses wakes when result projection fails", async () => {
        const account = await db.account.create({ data: { publicKey: "failed-publication-result" } });
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        const failure = new Error("result projection rejected");

        await expect(inTx(async tx => {
            const publication = await markAccountChanged(tx, {
                accountId: account.id, kind: "account", entityId: "settings",
            });
            return transactionResult(() => {
                expect(publication.resolveCursor()).toBe(1);
                throw failure;
            });
        })).rejects.toBe(failure);

        await expect(db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
            .resolves.toEqual({ seq: 0 });
        await expect(db.accountChange.findMany({ where: { accountId: account.id } })).resolves.toEqual([]);
        expect(emit).not.toHaveBeenCalled();
    });
});
