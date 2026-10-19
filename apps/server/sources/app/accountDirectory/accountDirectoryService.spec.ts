import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import {
    canonicalHomeLoginAssertionBytes,
} from "./accountDirectorySigner";
import {
    createHomeCredentialDestinationDigestV1,
    decodeBase64,
    encodeBase64,
    openBoxBundle,
} from "@happier-dev/protocol";
import type { HomeConnectionDescriptorV1, HomeLoginAssertionV1 } from "./accountDirectorySchemas";
import { readAccountDirectoryMe } from "./accountDirectoryService";

/**
 * Owner-level tests for the Account Directory domain service.
 * Only genuine boundaries are mocked: the database (including its transaction
 * client) and the server-identity storage helper. All directory logic, mapping,
 * signing, and sealing runs for real.
 */

type Row = Record<string, unknown>;
type FindArgs = { where: unknown; select?: unknown; data?: unknown };

const mocks = vi.hoisted(() => ({
    repeatKeyFindUnique: vi.fn(),
    dbAccountFindUnique: vi.fn(),
    dbAccountFindUniqueOrThrow: vi.fn(),
    dbEntryFindUnique: vi.fn(),
    dbEntryFindMany: vi.fn(),
    dbLinkFindUnique: vi.fn(),
    dbLinkFindFirst: vi.fn(),
    txAccountFindUnique: vi.fn(),
    txAccountFindUniqueOrThrow: vi.fn(),
    txAccountUpdateMany: vi.fn(),
    txEntryFindUnique: vi.fn(),
    txEntryFindFirst: vi.fn(),
    txEntryFindMany: vi.fn(),
    txEntryCreate: vi.fn(),
    txEntryUpdate: vi.fn(),
    txEntryDeleteMany: vi.fn(),
    txLinkFindFirst: vi.fn(),
    txLinkFindUnique: vi.fn(),
    txLinkCreate: vi.fn(),
    txLinkUpdate: vi.fn(),
    txLinkDeleteMany: vi.fn(),
    txPairingSessionDeleteMany: vi.fn(),
    txPairingSessionFindFirst: vi.fn(),
    getOrCreateServerIdentityId: vi.fn(),
    readCachedServerIdentityIdForHotPath: vi.fn(),
}));

// Substitute the Prisma boundary, retaining the real snapshot/transaction policy.
// Global reads and transactional writes have distinct delegates so bypasses fail.
vi.mock("@/storage/db", () => {
    const transaction = {
        $executeRaw: vi.fn(async () => 0),
        $executeRawUnsafe: vi.fn(async () => 0),
        $queryRaw: vi.fn(async () => [{ statement_timeout: "0" }]),
        $queryRawUnsafe: vi.fn(async () => [{ id: "account-1" }]),
        repeatKey: { findUnique: mocks.repeatKeyFindUnique },
        account: {
            findUnique: mocks.txAccountFindUnique,
            findUniqueOrThrow: mocks.txAccountFindUniqueOrThrow,
            updateMany: mocks.txAccountUpdateMany,
        },
        accountHomeDirectoryEntry: {
            findUnique: mocks.txEntryFindUnique,
            findFirst: mocks.txEntryFindFirst,
            findMany: mocks.txEntryFindMany,
            create: mocks.txEntryCreate,
            update: mocks.txEntryUpdate,
            deleteMany: mocks.txEntryDeleteMany,
        },
        accountDirectoryLink: {
            findUnique: mocks.txLinkFindUnique,
            findFirst: mocks.txLinkFindFirst,
            create: mocks.txLinkCreate,
            update: mocks.txLinkUpdate,
            deleteMany: mocks.txLinkDeleteMany,
        },
        authPairingSession: {
            deleteMany: mocks.txPairingSessionDeleteMany,
            findFirst: mocks.txPairingSessionFindFirst,
        },
    };
    return { db: {
        repeatKey: { findUnique: mocks.repeatKeyFindUnique },
        account: { findUnique: mocks.dbAccountFindUnique, findUniqueOrThrow: mocks.dbAccountFindUniqueOrThrow },
        accountHomeDirectoryEntry: { findUnique: mocks.dbEntryFindUnique, findMany: mocks.dbEntryFindMany },
        accountDirectoryLink: { findUnique: mocks.dbLinkFindUnique, findFirst: mocks.dbLinkFindFirst },
        $transaction: async (fn: (tx: typeof transaction) => Promise<unknown>) => fn(transaction),
    } };
});

vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    getOrCreateServerIdentityId: mocks.getOrCreateServerIdentityId,
    readCachedServerIdentityIdForHotPath: mocks.readCachedServerIdentityIdForHotPath,
}));

const state = { preferredHomeServerIdentityId: null as string | null };

function descriptor(homeServerIdentityId: string): Row {
    return {
        v: 1,
        homeServerIdentityId,
        canonicalServerUrl: `https://${homeServerIdentityId}.example.test`,
        revision: 1,
        endpoints: [{ kind: "https", url: `https://${homeServerIdentityId}.example.test` }],
    };
}

function descriptorAtRevision(homeServerIdentityId: string, revision: number, canonicalServerUrl?: string): Row {
    const url = canonicalServerUrl ?? `https://${homeServerIdentityId}.example.test`;
    return {
        v: 1,
        homeServerIdentityId,
        canonicalServerUrl: url,
        revision,
        endpoints: [{ kind: "https", url }],
    };
}

function entryRow(homeServerIdentityId: string, overrides: Row = {}): Row {
    return {
        accountId: "account-1",
        homeServerIdentityId,
        canonicalServerUrl: `https://${homeServerIdentityId}.example.test`,
        label: `Home ${homeServerIdentityId}`,
        connectionDescriptor: descriptor(homeServerIdentityId),
        createdAt: new Date(1_700_000_000_000),
        updatedAt: new Date(1_700_000_000_000),
        ...overrides,
    };
}

function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function bytesFromHex(hex: string): Uint8Array {
    return Uint8Array.from(Buffer.from(hex, "hex"));
}

function signingKeyPair(seed: number) {
    return tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed));
}

function linkRowFor(keyPair: ReturnType<typeof signingKeyPair>, overrides: Row = {}): Row {
    return {
        accountId: "account-1",
        issuerServerIdentityId: "srv_account",
        issuerSubjectId: "account-1",
        issuerSigningKeyId: sha256Hex(keyPair.publicKey),
        issuerSigningPublicKey: Buffer.from(keyPair.publicKey),
        createdAt: new Date(1_700_000_000_000),
        ...overrides,
    };
}

function linkPutParams(keyPair: ReturnType<typeof signingKeyPair>, overrides: Row = {}): Row {
    return {
        accountId: "account-1",
        issuerServerIdentityId: "srv_account",
        issuerSubjectId: "account-1",
        issuerSigningKeyId: sha256Hex(keyPair.publicKey),
        issuerSigningPublicKeyBase64Url: encodeBase64(keyPair.publicKey, "base64url"),
        ...overrides,
    };
}

const MINT_ENV = { HANDY_MASTER_SECRET: "test-master-secret" } as unknown as NodeJS.ProcessEnv;

describe("Account Directory service", () => {
    afterEach(() => { vi.unstubAllEnvs(); });
    beforeEach(() => {
        // This file substitutes Prisma, including its transaction boundary;
        // it must not select the separate real SQLite snapshot connection.
        vi.stubEnv("HAPPIER_DB_PROVIDER", "postgres");
        state.preferredHomeServerIdentityId = null;
        for (const mock of Object.values(mocks)) mock.mockReset();
        mocks.repeatKeyFindUnique.mockResolvedValue(null);
        mocks.txAccountFindUnique.mockImplementation(async () => ({
            id: "account-1",
            status: "active",
            preferredHomeServerIdentityId: state.preferredHomeServerIdentityId,
        }));
        mocks.txAccountFindUniqueOrThrow.mockResolvedValue({ id: "account-1", status: "active" });
        mocks.dbAccountFindUnique.mockImplementation(async () => ({
            id: "account-1",
            status: "active",
            preferredHomeServerIdentityId: state.preferredHomeServerIdentityId,
        }));
        mocks.dbAccountFindUniqueOrThrow.mockResolvedValue({ id: "account-1", status: "active" });
        mocks.txEntryFindMany.mockImplementation((args) => mocks.dbEntryFindMany(args));
        mocks.txAccountUpdateMany.mockImplementation(async (args: FindArgs) => {
            const data = args.data as { preferredHomeServerIdentityId: string | null } | undefined;
            if (data) state.preferredHomeServerIdentityId = data.preferredHomeServerIdentityId;
            return { count: 1 };
        });
        mocks.getOrCreateServerIdentityId.mockResolvedValue("srv_account");
        mocks.readCachedServerIdentityIdForHotPath.mockReturnValue("srv_home");
        mocks.txLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
        mocks.txPairingSessionDeleteMany.mockResolvedValue({ count: 0 });
    });

    it("labels the directory account from its explicit name and then username", async () => {
        const account = {
            id: "account-1",
            name: "  Ana María de la Cruz  ",
            firstName: "Old",
            lastName: "Identity",
            username: "ana",
            avatar: null,
            encryptionMode: "plain",
            AccountPasswordCredential: null,
            AccountIdentity: [],
        };
        let currentAccount: Row = account;
        mocks.txAccountFindUnique.mockImplementation(async (args: { select: Record<string, unknown> }) =>
            Object.fromEntries(Object.entries(currentAccount).filter(([field]) => args.select[field])));
        expect((await readAccountDirectoryMe(account.id)).displayName).toBe("Ana María de la Cruz");
        currentAccount = { ...account, name: null };
        expect((await readAccountDirectoryMe(account.id)).displayName).toBe("ana");
    });

    describe("directory entry upsert", () => {
        it("creates the first entry transactionally and prefers it when the account has no preferred Home", async () => {
            const { upsertAccountHomeDirectoryEntry } = await import("./accountDirectoryService");
            mocks.txEntryFindUnique.mockResolvedValue(null);
            mocks.txEntryFindFirst.mockResolvedValue(null);
            mocks.txEntryCreate.mockImplementation(async (args: FindArgs) => {
                const data = args.data as Row;
                return entryRow(data.homeServerIdentityId as string, data);
            });

            const result = await upsertAccountHomeDirectoryEntry({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_a",
                label: "Home A",
                connectionDescriptor: descriptor("srv_home_a"),
            });

            expect(mocks.txEntryCreate).toHaveBeenCalledTimes(1);
            const created = mocks.txEntryCreate.mock.calls[0]?.[0] as FindArgs;
            expect(created.data).toMatchObject({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_a",
                canonicalServerUrl: descriptor("srv_home_a").canonicalServerUrl,
            });
            expect(mocks.txAccountUpdateMany).toHaveBeenCalledWith({
                where: { id: "account-1", preferredHomeServerIdentityId: null },
                data: { preferredHomeServerIdentityId: "srv_home_a" },
            });
            expect(result.preferred).toBe(true);
            expect(result.canonicalServerUrl).toBe(descriptor("srv_home_a").canonicalServerUrl);
        });

        it("updates an existing entry transactionally without touching preferred state", async () => {
            const { upsertAccountHomeDirectoryEntry } = await import("./accountDirectoryService");
            state.preferredHomeServerIdentityId = "srv_home_b";
            mocks.txEntryFindUnique.mockResolvedValue(entryRow("srv_home_a"));
            mocks.txEntryUpdate.mockImplementation(async (args: FindArgs) => ({
                ...entryRow("srv_home_a"),
                ...(args.data as Row),
            }));

            const result = await upsertAccountHomeDirectoryEntry({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_a",
                label: "Home A renamed",
                connectionDescriptor: descriptor("srv_home_a"),
            });

            expect(mocks.txEntryUpdate).toHaveBeenCalledTimes(1);
            expect(mocks.txEntryCreate).not.toHaveBeenCalled();
            expect(mocks.txAccountUpdateMany).not.toHaveBeenCalled();
            expect(result.label).toBe("Home A renamed");
            expect(result.preferred).toBe(false);
        });

        it("preserves an explicit null preferred choice when an existing entry is upserted", async () => {
            const { upsertAccountHomeDirectoryEntry } = await import("./accountDirectoryService");
            state.preferredHomeServerIdentityId = null;
            mocks.txEntryFindUnique.mockResolvedValue(entryRow("srv_home_a"));
            mocks.txEntryUpdate.mockImplementation(async (args: FindArgs) => ({
                ...entryRow("srv_home_a"),
                ...(args.data as Row),
            }));

            const result = await upsertAccountHomeDirectoryEntry({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_a",
                label: "Home A renamed",
                connectionDescriptor: descriptor("srv_home_a"),
            });

            expect(mocks.txEntryCreate).not.toHaveBeenCalled();
            expect(mocks.txEntryUpdate).toHaveBeenCalledTimes(1);
            expect(mocks.txAccountUpdateMany).not.toHaveBeenCalled();
            expect(result.preferred).toBe(false);
        });

        it("preserves an explicit null preferred choice when another Home is added", async () => {
            const { upsertAccountHomeDirectoryEntry } = await import("./accountDirectoryService");
            state.preferredHomeServerIdentityId = null;
            mocks.txEntryFindUnique.mockResolvedValue(null);
            mocks.txEntryFindFirst.mockResolvedValue(entryRow("srv_home_a"));
            mocks.txEntryCreate.mockImplementation(async (args: FindArgs) => {
                const data = args.data as Row;
                return entryRow(data.homeServerIdentityId as string, data);
            });

            const result = await upsertAccountHomeDirectoryEntry({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_b",
                label: "Home B",
                connectionDescriptor: descriptor("srv_home_b"),
            });

            expect(mocks.txEntryCreate).toHaveBeenCalledTimes(1);
            expect(mocks.txAccountUpdateMany).not.toHaveBeenCalled();
            expect(result.preferred).toBe(false);
        });

        it("returns the current entry without mutation when a descriptor revision regresses", async () => {
            const { upsertAccountHomeDirectoryEntry } = await import("./accountDirectoryService");
            state.preferredHomeServerIdentityId = "srv_home_a";
            const current = entryRow("srv_home_a", {
                label: "Current Home",
                connectionDescriptor: descriptorAtRevision("srv_home_a", 5),
            });
            mocks.txEntryFindUnique.mockResolvedValue(current);

            const result = await upsertAccountHomeDirectoryEntry({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_a",
                label: "Stale Home",
                connectionDescriptor: descriptorAtRevision("srv_home_a", 4),
            });

            expect(mocks.txEntryUpdate).not.toHaveBeenCalled();
            expect(result).toMatchObject({ label: "Current Home", connectionDescriptor: { revision: 5 } });
        });

        it("rejects an equal-revision descriptor conflict without mutation", async () => {
            const { upsertAccountHomeDirectoryEntry } = await import("./accountDirectoryService");
            mocks.txEntryFindUnique.mockResolvedValue(entryRow("srv_home_a", {
                connectionDescriptor: descriptorAtRevision("srv_home_a", 5),
            }));

            await expect(upsertAccountHomeDirectoryEntry({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_a",
                label: "Conflicting Home",
                connectionDescriptor: descriptorAtRevision("srv_home_a", 5, "https://replacement.example.test"),
            })).rejects.toMatchObject({ code: "descriptor_revision_conflict" });
            expect(mocks.txEntryUpdate).not.toHaveBeenCalled();
        });

        it("stores the exact destination revision on relocation publication", async () => {
            const { upsertAccountHomeDirectoryEntry } = await import("./accountDirectoryService");
            const current = entryRow("srv_home_a", {
                connectionDescriptor: descriptorAtRevision("srv_home_a", 7),
            });
            mocks.txEntryFindUnique.mockResolvedValue(current);
            mocks.txEntryUpdate.mockImplementation(async (args: FindArgs) => ({
                ...current,
                ...(args.data as Row),
            }));

            const result = await upsertAccountHomeDirectoryEntry({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_a",
                label: "Moved Home",
                connectionDescriptor: descriptorAtRevision("srv_home_a", 27, "https://destination.example.test"),
            });

            expect(result.connectionDescriptor).toEqual({
                v: 1,
                homeServerIdentityId: "srv_home_a",
                canonicalServerUrl: "https://destination.example.test",
                revision: 27,
                endpoints: [{ kind: "https", url: "https://destination.example.test" }],
            });
        });

        it("creates a new identity beyond the former 256-Home boundary without a count query", async () => {
            const { listAccountHomeDirectory, upsertAccountHomeDirectoryEntry } = await import("./accountDirectoryService");
            const rowsByAccount = new Map<string, Row[]>([
                ["account-1", Array.from({ length: 256 }, (_, index) => {
                    const homeServerIdentityId = `srv_home_${index.toString().padStart(3, "0")}`;
                    return entryRow(homeServerIdentityId);
                })],
                ["account-2", []],
            ]);
            mocks.txAccountFindUnique.mockImplementation(async (args: FindArgs) => {
                const accountId = (args.where as { id: string }).id;
                return rowsByAccount.has(accountId)
                    ? { id: accountId, preferredHomeServerIdentityId: accountId === "account-1" ? "srv_home_000" : null }
                    : null;
            });
            mocks.dbAccountFindUnique.mockImplementation(async (args: FindArgs) => {
                const accountId = (args.where as { id: string }).id;
                return rowsByAccount.has(accountId)
                    ? { id: accountId, preferredHomeServerIdentityId: accountId === "account-1" ? "srv_home_000" : null }
                    : null;
            });
            mocks.txEntryFindUnique.mockImplementation(async (args: FindArgs) => {
                const key = (args.where as { accountId_homeServerIdentityId: { accountId: string; homeServerIdentityId: string } })
                    .accountId_homeServerIdentityId;
                return rowsByAccount.get(key.accountId)?.find((row) => row.homeServerIdentityId === key.homeServerIdentityId) ?? null;
            });
            mocks.txEntryCreate.mockImplementation(async (args: FindArgs) => {
                const data = args.data as Row & { accountId: string; homeServerIdentityId: string };
                const row = entryRow(data.homeServerIdentityId, data);
                rowsByAccount.get(data.accountId)?.push(row);
                return row;
            });
            mocks.txEntryUpdate.mockImplementation(async (args: FindArgs) => {
                const key = (args.where as { accountId_homeServerIdentityId: { accountId: string; homeServerIdentityId: string } })
                    .accountId_homeServerIdentityId;
                const rows = rowsByAccount.get(key.accountId) ?? [];
                const row = rows.find((candidate) => candidate.homeServerIdentityId === key.homeServerIdentityId);
                if (!row) throw new Error("missing fixture row");
                Object.assign(row, args.data as Row);
                return row;
            });
            mocks.dbEntryFindMany.mockImplementation(async (args: FindArgs) => {
                const accountId = (args.where as { accountId: string }).accountId;
                return rowsByAccount.get(accountId) ?? [];
            });

            await upsertAccountHomeDirectoryEntry({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_overflow",
                label: "Overflow Home",
                connectionDescriptor: descriptor("srv_home_overflow"),
            });

            expect((await listAccountHomeDirectory("account-1")).homes).toHaveLength(257);

            await upsertAccountHomeDirectoryEntry({
                accountId: "account-2",
                homeServerIdentityId: "srv_home_b",
                label: "Account B Home",
                connectionDescriptor: descriptor("srv_home_b"),
            });
            expect(rowsByAccount.get("account-2")).toHaveLength(1);
        });

        it("rejects a descriptor whose Home identity does not match the path identity", async () => {
            const { upsertAccountHomeDirectoryEntry } = await import("./accountDirectoryService");
            await expect(upsertAccountHomeDirectoryEntry({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_a",
                label: "Home A",
                connectionDescriptor: descriptor("srv_home_b"),
            })).rejects.toMatchObject({ code: "invalid_request" });
            expect(mocks.txEntryCreate).not.toHaveBeenCalled();
        });
    });

    describe("preferred Home selection", () => {
        it("sets preferred inside the transaction only for an existing directory entry", async () => {
            const { setPreferredAccountHome } = await import("./accountDirectoryService");
            mocks.txEntryFindUnique.mockResolvedValue({ homeServerIdentityId: "srv_home_a" });
            mocks.dbEntryFindMany.mockResolvedValue([entryRow("srv_home_a")]);

            const result = await setPreferredAccountHome({ accountId: "account-1", homeServerIdentityId: "srv_home_a" });

            expect(mocks.txAccountUpdateMany).toHaveBeenCalledWith({
                where: { id: "account-1" },
                data: { preferredHomeServerIdentityId: "srv_home_a" },
            });
            expect(result.preferredHomeServerIdentityId).toBe("srv_home_a");
            expect(result.homes[0]).toMatchObject({ homeServerIdentityId: "srv_home_a", preferred: true });
        });

        it("rejects preferred selection for a Home missing from the directory", async () => {
            const { setPreferredAccountHome } = await import("./accountDirectoryService");
            mocks.txEntryFindUnique.mockResolvedValue(null);

            await expect(setPreferredAccountHome({ accountId: "account-1", homeServerIdentityId: "srv_missing" }))
                .rejects.toMatchObject({ code: "preferred_home_not_found" });
            expect(mocks.txAccountUpdateMany).not.toHaveBeenCalled();
        });

        it("clears preferred selection transactionally without requiring a directory entry", async () => {
            const { setPreferredAccountHome } = await import("./accountDirectoryService");
            state.preferredHomeServerIdentityId = "srv_home_a";
            mocks.dbEntryFindMany.mockResolvedValue([]);

            const result = await setPreferredAccountHome({ accountId: "account-1", homeServerIdentityId: null });

            expect(mocks.txEntryFindUnique).not.toHaveBeenCalled();
            expect(mocks.txAccountUpdateMany).toHaveBeenCalledWith({
                where: { id: "account-1" },
                data: { preferredHomeServerIdentityId: null },
            });
            expect(result).toEqual({ v: 1, preferredHomeServerIdentityId: null, homes: [] });
        });

        it("clears the preferred pointer in the same transaction as the deletion", async () => {
            const { deleteAccountHomeDirectoryEntry } = await import("./accountDirectoryService");
            mocks.txEntryDeleteMany.mockResolvedValue({ count: 1 });

            await deleteAccountHomeDirectoryEntry({ accountId: "account-1", homeServerIdentityId: "srv_home_a" });

            expect(mocks.txEntryDeleteMany).toHaveBeenCalledWith({
                where: { accountId: "account-1", homeServerIdentityId: "srv_home_a" },
            });
            expect(mocks.txAccountUpdateMany).toHaveBeenCalledWith({
                where: { id: "account-1", preferredHomeServerIdentityId: "srv_home_a" },
                data: { preferredHomeServerIdentityId: null },
            });
        });
    });

    describe("strict descriptor/row mapping", () => {
        it("reads the preferred pointer and rows from one transaction snapshot", async () => {
            const { listAccountHomeDirectory } = await import("./accountDirectoryService");
            state.preferredHomeServerIdentityId = "srv_home_deleted";
            mocks.dbEntryFindMany.mockResolvedValue([entryRow("srv_home_b")]);
            mocks.txAccountFindUnique.mockResolvedValue({
                id: "account-1",
                preferredHomeServerIdentityId: null,
            });
            mocks.txEntryFindMany.mockResolvedValue([entryRow("srv_home_b")]);

            const result = await listAccountHomeDirectory("account-1");

            expect(result).toMatchObject({
                preferredHomeServerIdentityId: null,
                homes: [{ homeServerIdentityId: "srv_home_b", preferred: false }],
            });
            expect(mocks.txAccountFindUnique).toHaveBeenCalledTimes(1);
            expect(mocks.txEntryFindMany).toHaveBeenCalledTimes(1);
            expect(mocks.dbAccountFindUnique).not.toHaveBeenCalled();
            expect(mocks.dbEntryFindMany).not.toHaveBeenCalled();
        });

        it("rejects a stored row whose canonical URL diverges from its descriptor", async () => {
            const { listAccountHomeDirectory } = await import("./accountDirectoryService");
            mocks.dbEntryFindMany.mockResolvedValue([
                entryRow("srv_home_a", { canonicalServerUrl: "https://legacy.example.test" }),
            ]);

            await expect(listAccountHomeDirectory("account-1")).rejects.toMatchObject({ code: "invalid_request" });
        });

        it("maps canonical directory rows with preferred status through the protocol schema", async () => {
            const { listAccountHomeDirectory } = await import("./accountDirectoryService");
            state.preferredHomeServerIdentityId = "srv_home_a";
            mocks.dbEntryFindMany.mockResolvedValue([entryRow("srv_home_a"), entryRow("srv_home_b")]);

            const result = await listAccountHomeDirectory("account-1");

            expect(result).toMatchObject({
                v: 1,
                preferredHomeServerIdentityId: "srv_home_a",
            });
            expect(result.homes).toHaveLength(2);
            expect(result.homes[0]).toMatchObject({ homeServerIdentityId: "srv_home_a", preferred: true });
            expect(result.homes[1]).toMatchObject({ homeServerIdentityId: "srv_home_b", preferred: false });
        });

        it("rejects a stored row whose identity diverges from its descriptor", async () => {
            const { listAccountHomeDirectory } = await import("./accountDirectoryService");
            mocks.dbEntryFindMany.mockResolvedValue([
                entryRow("srv_home_a", { connectionDescriptor: descriptor("srv_home_b") }),
            ]);

            await expect(listAccountHomeDirectory("account-1")).rejects.toMatchObject({ code: "invalid_request" });
        });
    });

    describe("directory link upsert", () => {
        it("creates a fresh issuer link inside the transaction", async () => {
            const { upsertAccountDirectoryLink } = await import("./accountDirectoryService");
            const keyPair = signingKeyPair(11);
            mocks.txLinkFindFirst.mockResolvedValue(null);

            await upsertAccountDirectoryLink(linkPutParams(keyPair) as never);

            expect(mocks.txLinkCreate).toHaveBeenCalledTimes(1);
            const created = mocks.txLinkCreate.mock.calls[0]?.[0] as { data: Row };
            expect(created.data).toMatchObject({
                accountId: "account-1",
                issuerServerIdentityId: "srv_account",
                issuerSubjectId: "account-1",
                issuerSigningKeyId: sha256Hex(keyPair.publicKey),
            });
            expect(Buffer.from(created.data.issuerSigningPublicKey as Uint8Array).equals(Buffer.from(keyPair.publicKey)))
                .toBe(true);
        });

        it("requires explicit re-link when the pinned issuer signing key changes and never rotates silently", async () => {
            const { upsertAccountDirectoryLink } = await import("./accountDirectoryService");
            const currentPair = signingKeyPair(11);
            const nextPair = signingKeyPair(12);
            mocks.txLinkFindFirst.mockResolvedValue(linkRowFor(currentPair));

            await expect(upsertAccountDirectoryLink(linkPutParams(nextPair) as never))
                .rejects.toMatchObject({ code: "directory_link_conflict" });
            expect(mocks.txLinkUpdate).not.toHaveBeenCalled();
            expect(mocks.txLinkDeleteMany).not.toHaveBeenCalled();
            expect(mocks.txLinkCreate).not.toHaveBeenCalled();
        });

        it("treats an identical link PUT as idempotent without rewriting the pinned trust row", async () => {
            const { upsertAccountDirectoryLink } = await import("./accountDirectoryService");
            const keyPair = signingKeyPair(11);
            mocks.txLinkFindFirst.mockResolvedValue(linkRowFor(keyPair));

            await upsertAccountDirectoryLink(linkPutParams(keyPair) as never);

            expect(mocks.txLinkUpdate).not.toHaveBeenCalled();
            expect(mocks.txLinkDeleteMany).not.toHaveBeenCalled();
            expect(mocks.txLinkCreate).not.toHaveBeenCalled();
        });

        it("rotates the pinned key only when relink is explicit", async () => {
            const { upsertAccountDirectoryLink } = await import("./accountDirectoryService");
            const currentPair = signingKeyPair(11);
            const nextPair = signingKeyPair(12);
            mocks.txLinkFindFirst.mockResolvedValue(linkRowFor(currentPair));

            await upsertAccountDirectoryLink(linkPutParams(nextPair, { relink: true }) as never);

            expect(mocks.txLinkUpdate).toHaveBeenCalledTimes(1);
            const updated = mocks.txLinkUpdate.mock.calls[0]?.[0] as { data: Row };
            expect(updated.data).toMatchObject({ issuerSigningKeyId: sha256Hex(nextPair.publicKey) });
            expect(mocks.txLinkDeleteMany).not.toHaveBeenCalled();
            expect(mocks.txLinkCreate).not.toHaveBeenCalled();
        });

        it("rejects an issuer subject change without re-link", async () => {
            const { upsertAccountDirectoryLink } = await import("./accountDirectoryService");
            const keyPair = signingKeyPair(11);
            mocks.txLinkFindFirst.mockResolvedValue(linkRowFor(keyPair));

            await expect(upsertAccountDirectoryLink(linkPutParams(keyPair, { issuerSubjectId: "account-2" }) as never))
                .rejects.toMatchObject({ code: "directory_link_conflict" });
            expect(mocks.txLinkDeleteMany).not.toHaveBeenCalled();
        });

        it("re-creates the link under a new subject only when relink is explicit", async () => {
            const { upsertAccountDirectoryLink } = await import("./accountDirectoryService");
            const keyPair = signingKeyPair(11);
            mocks.txLinkFindFirst.mockResolvedValue(linkRowFor(keyPair));

            await upsertAccountDirectoryLink(linkPutParams(keyPair, { issuerSubjectId: "account-2", relink: true }) as never);

            expect(mocks.txLinkDeleteMany).toHaveBeenCalledWith({
                where: { accountId: "account-1", issuerServerIdentityId: "srv_account" },
            });
            expect(mocks.txLinkCreate).toHaveBeenCalledTimes(1);
            const created = mocks.txLinkCreate.mock.calls[0]?.[0] as { data: Row };
            expect(created.data).toMatchObject({ issuerSubjectId: "account-2" });
            expect(mocks.txLinkUpdate).not.toHaveBeenCalled();
        });

        it("rejects a link whose keyId does not match the SHA-256 of the pinned public key", async () => {
            const { upsertAccountDirectoryLink } = await import("./accountDirectoryService");
            const keyPair = signingKeyPair(13);

            await expect(upsertAccountDirectoryLink(
                linkPutParams(keyPair, { issuerSigningKeyId: "e".repeat(64) }) as never,
            )).rejects.toMatchObject({ code: "invalid_request" });
            expect(mocks.txLinkCreate).not.toHaveBeenCalled();
            expect(mocks.txLinkUpdate).not.toHaveBeenCalled();
        });

        it("rejects standard base64 where the link contract requires canonical unpadded base64url", async () => {
            const { upsertAccountDirectoryLink } = await import("./accountDirectoryService");
            const keyPair = signingKeyPair(13);

            await expect(upsertAccountDirectoryLink(linkPutParams(keyPair, {
                issuerSigningPublicKeyBase64Url: encodeBase64(keyPair.publicKey, "base64"),
            }) as never)).rejects.toBeDefined();
            expect(mocks.txLinkCreate).not.toHaveBeenCalled();
        });

        it("rejects a forwarded body issuer identity that differs from the path identity", async () => {
            const { upsertAccountDirectoryLink } = await import("./accountDirectoryService");
            const keyPair = signingKeyPair(11);

            await expect(upsertAccountDirectoryLink(
                linkPutParams(keyPair, { bodyIssuerServerIdentityId: "srv_other" }) as never,
            )).rejects.toMatchObject({ code: "invalid_request" });
            expect(mocks.txLinkCreate).not.toHaveBeenCalled();
        });

        it("deletes only the account-scoped issuer link inside the transaction", async () => {
            const { deleteAccountDirectoryLink } = await import("./accountDirectoryService");
            mocks.txLinkDeleteMany.mockResolvedValue({ count: 1 });

            await deleteAccountDirectoryLink({ accountId: "account-1", issuerServerIdentityId: "srv_account" });

            expect(mocks.txLinkDeleteMany).toHaveBeenCalledWith({
                where: { accountId: "account-1", issuerServerIdentityId: "srv_account" },
            });
        });
    });

    describe("assertion minting", () => {
        it("mints from Account Service directory membership alone and never consults Home links", async () => {
            const { mintAccountHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbEntryFindUnique.mockResolvedValue(entryRow("srv_home_a"));

            const assertion = await mintAccountHomeLoginAssertion({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_a",
                clientBoxPublicKeyBase64: privacyKit.encodeBase64(new Uint8Array(32).fill(3)),
                env: MINT_ENV,
            });

            expect(assertion).toMatchObject({
                v: 1,
                purpose: "happier.home-login",
                issuerServerIdentityId: "srv_account",
                issuerSubjectId: "account-1",
                audienceHomeServerIdentityId: "srv_home_a",
                credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(
                    descriptor("srv_home_a") as HomeConnectionDescriptorV1,
                ),
            });
            expect(mocks.dbLinkFindUnique).not.toHaveBeenCalled();
        });

        it("rejects minting when the stored descriptor identity does not match the target Home", async () => {
            const { mintAccountHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbEntryFindUnique.mockResolvedValue(entryRow("srv_home_b", {
                connectionDescriptor: descriptor("srv_home_a"),
            }));

            await expect(mintAccountHomeLoginAssertion({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_b",
                clientBoxPublicKeyBase64: privacyKit.encodeBase64(new Uint8Array(32).fill(3)),
                env: MINT_ENV,
            })).rejects.toMatchObject({ code: "invalid_request" });
        });

        it("requires standard canonical base64 for the assertion client box key", async () => {
            const { mintAccountHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbEntryFindUnique.mockResolvedValue(entryRow("srv_home_a"));

            await expect(mintAccountHomeLoginAssertion({
                accountId: "account-1",
                homeServerIdentityId: "srv_home_a",
                clientBoxPublicKeyBase64: encodeBase64(new Uint8Array(32).fill(3), "base64url"),
                env: MINT_ENV,
            })).rejects.toMatchObject({ code: "invalid_request" });
        });

        it("rejects syntactically canonical low-order client box keys with invalid_client_key", async () => {
            const { mintAccountHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbEntryFindUnique.mockResolvedValue(entryRow("srv_home_a"));

            const lowOrderKeys: ReadonlyArray<Uint8Array> = [
                new Uint8Array(32),
                bytesFromHex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
            ];
            for (const key of lowOrderKeys) {
                await expect(mintAccountHomeLoginAssertion({
                    accountId: "account-1",
                    homeServerIdentityId: "srv_home_a",
                    clientBoxPublicKeyBase64: encodeBase64(key, "base64"),
                    env: MINT_ENV,
                })).rejects.toMatchObject({ code: "invalid_client_key" });
            }
            // Rejection is cryptographic and happens before any directory work.
            expect(mocks.dbEntryFindUnique).not.toHaveBeenCalled();
        });
    });

    describe("Home login assertion redemption", () => {
        const nowMs = 1_700_000_000_001;
        const homeDescriptor = {
            v: 1 as const,
            homeServerIdentityId: "srv_home",
            canonicalServerUrl: "https://home.test",
            revision: 1,
            endpoints: [{ kind: "https" as const, url: "https://home.test" }],
        };

        function signedAssertion(overrides: Partial<Omit<HomeLoginAssertionV1, "signatureBase64Url">> = {}, seed = 4): Row {
            const keyPair = signingKeyPair(seed);
            const unsigned: Omit<HomeLoginAssertionV1, "signatureBase64Url"> = {
                v: 1,
                purpose: "happier.home-login",
                issuerServerIdentityId: "srv_account",
                issuerSubjectId: "account-1",
                audienceHomeServerIdentityId: "srv_home",
                credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(homeDescriptor),
                clientBoxPublicKeyBase64: privacyKit.encodeBase64(new Uint8Array(32).fill(1)),
                issuedAtMs: 1_700_000_000_000,
                expiresAtMs: 1_700_000_180_000,
                keyId: sha256Hex(keyPair.publicKey),
                ...overrides,
            };
            const signature = tweetnacl.sign.detached(canonicalHomeLoginAssertionBytes(unsigned), keyPair.secretKey);
            return { ...unsigned, signatureBase64Url: encodeBase64(signature, "base64url") };
        }

        const allowedGate = { evaluate: async () => ({ kind: "allowed" as const }) };
        const resolveStableHomeConnectionDescriptor = async () => homeDescriptor;
        it("resolves the Home identity through the read-only lookup and never creates one", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));

            const result = await redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: resolveStableHomeConnectionDescriptor,
                homeApprovalGate: allowedGate,
                issueHomeToken: async () => "home-token",
            });

            expect(result).toMatchObject({ v: 1, homeServerIdentityId: "srv_home" });
            expect(result).not.toHaveProperty("outcome");
            expect(mocks.readCachedServerIdentityIdForHotPath).toHaveBeenCalled();
            expect(mocks.getOrCreateServerIdentityId).not.toHaveBeenCalled();
        });

        it("fails closed when the Home identity is not established", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.readCachedServerIdentityIdForHotPath.mockReturnValue(null);

            await expect(redeemHomeLoginAssertion({ assertion: signedAssertion(), nowMs, homeApprovalGate: allowedGate }))
                .rejects.toMatchObject({ code: "home_redemption_unavailable" });
            expect(mocks.getOrCreateServerIdentityId).not.toHaveBeenCalled();
        });

        it("rejects a changed credential destination before approval or token issuance", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            const homeApprovalGate = { evaluate: vi.fn(async () => ({ kind: "allowed" as const })) };
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: async () => ({
                    ...homeDescriptor,
                    canonicalServerUrl: "https://attacker.test",
                    endpoints: [{ kind: "https", url: "https://attacker.test" }],
                }),
                homeApprovalGate,
                issueHomeToken,
            })).rejects.toMatchObject({ code: "credential_destination_mismatch" });
            expect(homeApprovalGate.evaluate).not.toHaveBeenCalled();
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("fails closed before approval when the canonical Home descriptor is unavailable", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            const homeApprovalGate = { evaluate: vi.fn(async () => ({ kind: "allowed" as const })) };
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: async () => undefined,
                homeApprovalGate,
                issueHomeToken,
            })).rejects.toMatchObject({ code: "home_redemption_unavailable" });
            expect(homeApprovalGate.evaluate).not.toHaveBeenCalled();
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("revalidates an allowed destination immediately before issuance", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            const resolveHomeConnectionDescriptor = vi.fn()
                .mockResolvedValueOnce(homeDescriptor)
                .mockResolvedValueOnce({
                    ...homeDescriptor,
                    endpoints: [{ kind: "https", url: "https://replacement.test" }],
                });
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor,
                homeApprovalGate: allowedGate,
                issueHomeToken,
            })).rejects.toMatchObject({ code: "credential_destination_mismatch" });
            expect(resolveHomeConnectionDescriptor).toHaveBeenCalledTimes(2);
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("revalidates after transactional link checks before issuing the Home token", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            let currentDescriptor: HomeConnectionDescriptorV1 = homeDescriptor;
            mocks.txLinkFindUnique.mockImplementation(async () => {
                currentDescriptor = {
                    ...homeDescriptor,
                    endpoints: [{ kind: "https", url: "https://replacement.test" }],
                };
                return linkRowFor(signingKeyPair(4));
            });
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: async () => currentDescriptor,
                homeApprovalGate: allowedGate,
                issueHomeToken,
            })).rejects.toMatchObject({ code: "credential_destination_mismatch" });
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("accepts revision and Iroh routing-hint changes that preserve the credential destination", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            const initialDescriptor = {
                ...homeDescriptor,
                endpoints: [
                    ...homeDescriptor.endpoints,
                    {
                        kind: "iroh" as const,
                        endpointId: "a".repeat(64),
                        relayUrls: ["https://relay-a.test"],
                        directAddresses: ["127.0.0.1:7777"],
                    },
                ],
            };
            const changedHintsDescriptor = {
                ...initialDescriptor,
                revision: 99,
                endpoints: [
                    ...homeDescriptor.endpoints,
                    {
                        kind: "iroh" as const,
                        endpointId: "a".repeat(64),
                        relayUrls: ["https://relay-b.test"],
                        directAddresses: ["10.0.0.8:8888"],
                    },
                ],
            };
            const resolveHomeConnectionDescriptor = vi.fn()
                .mockResolvedValueOnce(initialDescriptor)
                .mockResolvedValueOnce(changedHintsDescriptor);
            const issueHomeToken = vi.fn(async () => "home-token");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion({
                    credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(initialDescriptor),
                }),
                nowMs,
                resolveHomeConnectionDescriptor,
                homeApprovalGate: allowedGate,
                issueHomeToken,
            })).resolves.toMatchObject({ v: 1, homeServerIdentityId: "srv_home" });
            expect(resolveHomeConnectionDescriptor).toHaveBeenCalledTimes(2);
            expect(issueHomeToken).toHaveBeenCalledTimes(1);
        });

        it("does not issue a Home token when an approved request expires during final destination validation", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            const approvalExpiresAtMs = nowMs + 10_000;
            mocks.txPairingSessionFindFirst.mockResolvedValue({
                id: "approval-1",
                expiresAt: new Date(approvalExpiresAtMs),
            });
            let descriptorReads = 0;
            const resolveHomeConnectionDescriptor = vi.fn(async () => {
                descriptorReads += 1;
                if (descriptorReads === 2) vi.setSystemTime(approvalExpiresAtMs + 1);
                return homeDescriptor;
            });
            const issueHomeToken = vi.fn(async () => "must-never-issue");
            vi.useFakeTimers();
            vi.setSystemTime(nowMs);
            try {
                await expect(redeemHomeLoginAssertion({
                    assertion: signedAssertion(),
                    resolveHomeConnectionDescriptor,
                    homeApprovalGate: {
                        evaluate: async (facts) => ({
                            kind: "allowed" as const,
                            approvedRequest: { approvalId: "approval-1", bindingProof: facts.approvalBindingProof },
                        }),
                    },
                    issueHomeToken,
                })).rejects.toMatchObject({ code: "approval_expired" });
                expect(issueHomeToken).not.toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });

        it("verifies the assertion against the pinned link and returns typed failures", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            const assertion = signedAssertion();

            // No link for the issuer at all.
            mocks.dbLinkFindUnique.mockResolvedValue(null);
            mocks.dbLinkFindFirst.mockResolvedValue(null);
            await expect(redeemHomeLoginAssertion({ assertion, nowMs, homeApprovalGate: allowedGate }))
                .rejects.toMatchObject({ code: "directory_link_not_found" });

            // The issuer is linked, but not for the assertion's exact subject.
            mocks.dbLinkFindFirst.mockResolvedValue({ issuerSubjectId: "another-subject" });
            await expect(redeemHomeLoginAssertion({ assertion, nowMs, homeApprovalGate: allowedGate }))
                .rejects.toMatchObject({ code: "invalid_subject" });

            // Link pinned to a different issuer key than the assertion key ID.
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(5)));
            await expect(redeemHomeLoginAssertion({ assertion, nowMs, homeApprovalGate: allowedGate }))
                .rejects.toMatchObject({ code: "assertion_issuer_untrusted" });

            // Expired assertion.
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            await expect(redeemHomeLoginAssertion({ assertion, nowMs: 1_700_000_210_001, homeApprovalGate: allowedGate }))
                .rejects.toMatchObject({ code: "assertion_expired" });

            // Wrong audience.
            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion({ audienceHomeServerIdentityId: "srv_other" }),
                nowMs,
                homeApprovalGate: allowedGate,
            })).rejects.toMatchObject({ code: "assertion_wrong_audience" });

            // Future-issued beyond the bounded skew is a clock-skew failure,
            // distinct from expiry and from an invalid signature.
            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion({
                    issuedAtMs: 1_700_000_031_001,
                    expiresAtMs: 1_700_000_211_001,
                }),
                nowMs,
                homeApprovalGate: allowedGate,
            })).rejects.toMatchObject({ code: "assertion_clock_skew" });

            expect(mocks.readCachedServerIdentityIdForHotPath).toHaveBeenCalled();
        });

        it.each([
            {
                field: "issuerServerIdentityId" as const,
                storedValue: "SRV_ACCOUNT",
                expectedCode: "assertion_issuer_untrusted",
            },
            {
                field: "issuerSubjectId" as const,
                storedValue: "ACCOUNT-1",
                expectedCode: "invalid_subject",
            },
        ])("rejects a byte-different stored $field returned by the initial link lookup", async ({
            field,
            storedValue,
            expectedCode,
        }) => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4), { [field]: storedValue }));
            const homeApprovalGate = { evaluate: vi.fn(async () => ({ kind: "allowed" as const })) };
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                homeApprovalGate,
                issueHomeToken,
            })).rejects.toMatchObject({ code: expectedCode });
            expect(homeApprovalGate.evaluate).not.toHaveBeenCalled();
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it.each([
            {
                field: "issuerServerIdentityId" as const,
                storedValue: "SRV_ACCOUNT",
                expectedCode: "assertion_issuer_untrusted",
            },
            {
                field: "issuerSubjectId" as const,
                storedValue: "ACCOUNT-1",
                expectedCode: "invalid_subject",
            },
        ])("rejects a byte-different stored $field returned by the post-approval reread", async ({
            field,
            storedValue,
            expectedCode,
        }) => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            mocks.txLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4), { [field]: storedValue }));
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: resolveStableHomeConnectionDescriptor,
                homeApprovalGate: allowedGate,
                issueHomeToken,
            })).rejects.toMatchObject({ code: expectedCode });
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("never issues or seals a token for a low-order assertion client key", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion({ clientBoxPublicKeyBase64: privacyKit.encodeBase64(new Uint8Array(32)) }),
                nowMs,
                homeApprovalGate: allowedGate,
                issueHomeToken,
            })).rejects.toMatchObject({ code: "invalid_client_key" });
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("does not issue a token when the exact issuer link is deleted while approval is pending", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            mocks.txLinkFindUnique.mockResolvedValue(null);
            mocks.txLinkFindFirst.mockResolvedValue(null);
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: resolveStableHomeConnectionDescriptor,
                homeApprovalGate: allowedGate,
                issueHomeToken,
            })).rejects.toMatchObject({ code: "directory_link_not_found" });
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("does not issue a token when the pinned issuer key is replaced while approval is pending", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            mocks.txLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(5)));
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: resolveStableHomeConnectionDescriptor,
                homeApprovalGate: allowedGate,
                issueHomeToken,
            })).rejects.toMatchObject({ code: "assertion_issuer_untrusted" });
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("does not issue a token when the exact issuer link moves to another Home account while approval is pending", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            const approvedLink = linkRowFor(signingKeyPair(4));
            mocks.dbLinkFindUnique.mockResolvedValue(approvedLink);
            mocks.txLinkFindUnique.mockResolvedValue({ ...approvedLink, accountId: "account-2" });
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: resolveStableHomeConnectionDescriptor,
                homeApprovalGate: allowedGate,
                issueHomeToken,
            })).rejects.toMatchObject({ code: "assertion_issuer_untrusted" });
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("seals the ordinary Home token to the assertion client key and never returns plaintext", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            const clientBoxKeyPair = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9));
            const otherBoxKeyPair = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(10));
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            const issueHomeToken = vi.fn(async () => "ordinary-home-local-token");

            const result = await redeemHomeLoginAssertion({
                assertion: signedAssertion({
                    clientBoxPublicKeyBase64: privacyKit.encodeBase64(new Uint8Array(clientBoxKeyPair.publicKey)),
                }),
                nowMs,
                resolveHomeConnectionDescriptor: resolveStableHomeConnectionDescriptor,
                homeApprovalGate: allowedGate,
                issueHomeToken,
            });

            expect(issueHomeToken).toHaveBeenCalledWith(expect.anything(), "account-1");
            // The authorized result is strict and contains no plaintext Home token material.
            expect(Object.keys(result).sort()).toEqual([
                "expiresAtMs",
                "homeServerIdentityId",
                "issuedAtMs",
                "sealedHomeTokenBase64Url",
                "v",
            ]);
            expect(result).toMatchObject({ v: 1, homeServerIdentityId: "srv_home" });
            expect(JSON.stringify(result)).not.toContain("ordinary-home-local-token");

            const sealed = decodeBase64((result as { sealedHomeTokenBase64Url: string }).sealedHomeTokenBase64Url, "base64url");
            const opened = openBoxBundle({ bundle: sealed, recipientSecretKeyOrSeed: clientBoxKeyPair.secretKey });
            const plaintext = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened as Uint8Array)) as unknown;
            expect(plaintext).toEqual({ token: "ordinary-home-local-token" });
            expect(Object.keys(plaintext as Record<string, unknown>)).toEqual(["token"]);
            expect((result as { expiresAtMs: number }).expiresAtMs).toBe(1_700_000_180_000);
            // A different client key cannot open the sealed token.
            expect(openBoxBundle({ bundle: sealed, recipientSecretKeyOrSeed: otherBoxKeyPair.secretKey })).toBeNull();
        });

        it("maps an explicit trusted-device rejection to the distinct public approval_rejected error", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: resolveStableHomeConnectionDescriptor,
                homeApprovalGate: { evaluate: async () => ({ kind: "rejected" as const }) },
                issueHomeToken,
            })).rejects.toMatchObject({ code: "approval_rejected" });
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("maps an expired pending approval to the distinct public approval_expired error", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: resolveStableHomeConnectionDescriptor,
                homeApprovalGate: { evaluate: async () => ({ kind: "expired" as const }) },
                issueHomeToken,
            })).rejects.toMatchObject({ code: "approval_expired" });
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("maps an invalid pending approval to the distinct public approval_invalid error", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: resolveStableHomeConnectionDescriptor,
                homeApprovalGate: { evaluate: async () => ({ kind: "invalid" as const }) },
                issueHomeToken,
            })).rejects.toMatchObject({ code: "approval_invalid" });
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("maps transaction-time relinking after approval to approval_invalid", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));
            mocks.txLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(5)));
            const issueHomeToken = vi.fn(async () => "must-never-issue");

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                resolveHomeConnectionDescriptor: resolveStableHomeConnectionDescriptor,
                homeApprovalGate: {
                    evaluate: async () => ({
                        kind: "allowed" as const,
                        approvedRequest: { approvalId: "approval-1", bindingProof: "approved-binding" },
                    }),
                },
                issueHomeToken,
            })).rejects.toMatchObject({ code: "approval_invalid" });
            expect(issueHomeToken).not.toHaveBeenCalled();
        });

        it("rejects a Home token that exceeds the canonical ordinary-token boundary", async () => {
            const { redeemHomeLoginAssertion } = await import("./accountDirectoryService");
            mocks.dbLinkFindUnique.mockResolvedValue(linkRowFor(signingKeyPair(4)));

            await expect(redeemHomeLoginAssertion({
                assertion: signedAssertion(),
                nowMs,
                homeApprovalGate: allowedGate,
                issueHomeToken: async () => "t".repeat(4_097),
            })).rejects.toMatchObject({ code: "home_redemption_unavailable" });
        });
    });
});
