import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";

import { db } from "@/storage/db";
import { withSqliteReadSnapshot } from "@/storage/prisma";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { inspectSessionAccessGrants } from "@/app/session/access/sessionAccessGrantInspection";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { readmitSessionRowsWithAdmissionInTx } from "@/app/session/access/sessionReadAdmission";
import { SessionMetadataPrivacyUpgradeRequiredError } from "@/app/session/metadata/sessionMetadataRecipientProjection";

type Deferred = Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}>;

function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function expectBarrierEnteredBeforeResponse(
    barrier: Readonly<{ reached: Promise<void> }>,
    response: Promise<unknown>,
): Promise<void> {
    await expect(Promise.race([
        barrier.reached.then(() => "barrier-entered" as const),
        response.then(() => "response-completed" as const),
    ])).resolves.toBe("barrier-entered");
}

async function installPauseBeforeReadTransaction(): Promise<Readonly<{
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
}>> {
    const reached = deferred();
    const release = deferred();
    const originalTransaction = db.$transaction;
    // Capture the real storage-owned client, without replacing the snapshot
    // owner or any access logic. BEGIN is the same boundary as $transaction.
    const snapshotReader = await withSqliteReadSnapshot(async reader => reader);
    const originalSnapshotExecute = snapshotReader.$executeRawUnsafe.bind(snapshotReader);
    let paused = false;
    let restored = false;

    db.$transaction = (async (...args: unknown[]) => {
        if (!paused && typeof args[0] === "function") {
            paused = true;
            reached.resolve();
            await release.promise;
        }
        return await Reflect.apply(originalTransaction, undefined, args);
    }) as typeof db.$transaction;
    Object.defineProperty(snapshotReader, "$executeRawUnsafe", {
        configurable: true,
        writable: true,
        value: async (query: string, ...values: unknown[]) => {
            if (!paused && query === "BEGIN DEFERRED;") {
                paused = true;
                reached.resolve();
                await release.promise;
            }
            return await Reflect.apply(originalSnapshotExecute, snapshotReader, [query, ...values]);
        },
    });

    return {
        reached: reached.promise,
        release: release.resolve,
        restore: () => {
            if (restored) return;
            restored = true;
            release.resolve();
            db.$transaction = originalTransaction;
            Object.defineProperty(snapshotReader, "$executeRawUnsafe", {
                configurable: true,
                writable: true,
                value: originalSnapshotExecute,
            });
        },
    };
}

async function installPauseBeforeModelRead(input: Readonly<{
    model: "sessionTurn";
    method: "findMany";
} | {
    model: "sessionMessage";
    method: "findFirst" | "findMany";
}>): Promise<Readonly<{
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
}>> {
    const reached = deferred();
    const release = deferred();
    const directDelegate = db[input.model];
    // Prisma delegates are the real database boundary; preserve their receiver.
    const originalDirectRead = (Reflect.get(directDelegate, input.method) as Function).bind(directDelegate);
    const snapshotReader = await withSqliteReadSnapshot(async reader => reader);
    const snapshotDelegate = snapshotReader[input.model];
    const originalSnapshotRead = (Reflect.get(snapshotDelegate, input.method) as Function).bind(snapshotDelegate);
    const originalTransaction = db.$transaction;
    let paused = false;
    let restored = false;

    const pause = async (): Promise<void> => {
        if (paused) return;
        paused = true;
        reached.resolve();
        await release.promise;
    };

    Object.defineProperty(directDelegate, input.method, {
        configurable: true,
        writable: true,
        value: async (...args: unknown[]) => {
            await pause();
            return await Reflect.apply(originalDirectRead, directDelegate, args);
        },
    });
    Object.defineProperty(snapshotDelegate, input.method, {
        configurable: true,
        writable: true,
        value: async (...args: unknown[]) => {
            await pause();
            return await Reflect.apply(originalSnapshotRead, snapshotDelegate, args);
        },
    });
    db.$transaction = (async (...args: unknown[]) => {
        const operation = args[0];
        if (typeof operation !== "function") {
            return await Reflect.apply(originalTransaction, undefined, args);
        }

        return await Reflect.apply(originalTransaction, undefined, [
            async (tx: object) => {
                const transactionDelegate = Reflect.get(tx, input.model) as object;
                const originalRead = Reflect.get(transactionDelegate, input.method) as Function;
                const wrappedDelegate = new Proxy(transactionDelegate, {
                    get(target, property, receiver) {
                        if (property !== input.method) return Reflect.get(target, property, receiver);
                        return async (...readArgs: unknown[]) => {
                            await pause();
                            return await Reflect.apply(originalRead, target, readArgs);
                        };
                    },
                });
                const wrappedTx = new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === input.model) return wrappedDelegate;
                        return Reflect.get(target, property, receiver);
                    },
                });
                return await operation(wrappedTx);
            },
            ...args.slice(1),
        ]);
    }) as typeof db.$transaction;

    return {
        reached: reached.promise,
        release: release.resolve,
        restore: () => {
            if (restored) return;
            restored = true;
            release.resolve();
            Object.defineProperty(directDelegate, input.method, {
                configurable: true,
                writable: true,
                value: originalDirectRead,
            });
            Object.defineProperty(snapshotDelegate, input.method, {
                configurable: true,
                writable: true,
                value: originalSnapshotRead,
            });
            db.$transaction = originalTransaction;
        },
    };
}

async function createSharedSessionFixture(): Promise<Readonly<{
    ownerId: string;
    collaboratorId: string;
    sessionId: string;
    messageId: string;
    localId: string;
    observedRevision: string;
}>> {
    const owner = await db.account.create({
        data: { publicKey: `pk-current-member-owner-${crypto.randomUUID()}`, encryptionMode: "plain" },
        select: { id: true },
    });
    const collaborator = await db.account.create({
        data: { publicKey: `pk-current-member-collaborator-${crypto.randomUUID()}`, encryptionMode: "plain" },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            tag: `current-member-${crypto.randomUUID()}`,
            accountId: owner.id,
            encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }),
            agentState: null,
        },
        select: { id: true },
    });
    await db.sessionShare.create({
        data: {
            sessionId: session.id,
            sharedByUserId: owner.id,
            sharedWithUserId: collaborator.id,
            accessLevel: "view",
        },
    });
    const message = await db.sessionMessage.create({
        data: {
            sessionId: session.id,
            localId: "input-1",
            seq: 1,
            messageRole: "user",
            content: {
                t: "plain",
                v: {
                    role: "user",
                    content: { type: "text", text: "private transcript content" },
                },
            },
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedAccount",
                actorAccountId: collaborator.id,
                sessionRelationship: "sharedEditor",
            },
        },
        select: { id: true, updatedAt: true },
    });
    await db.sessionTurn.create({
        data: {
            sessionId: session.id,
            turnId: "turn-1",
            status: "completed",
            startedAt: 1n,
            updatedAt: 2n,
        },
    });

    return {
        ownerId: owner.id,
        collaboratorId: collaborator.id,
        sessionId: session.id,
        messageId: message.id,
        localId: "input-1",
        observedRevision: `message-updated-at:${message.updatedAt.getTime()}`,
    };
}

async function revokeShare(params: Readonly<{ sessionId: string; collaboratorId: string }>): Promise<void> {
    await db.sessionShare.delete({
        where: {
            sessionId_sharedWithUserId: {
                sessionId: params.sessionId,
                sharedWithUserId: params.collaboratorId,
            },
        },
    });
}

describe("sessionRoutes current shared-participant reads (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-current-participant-",
            initAuth: false,
            sqliteConnectionLimit: 2,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.sessionTurnMutationReceipt.deleteMany(),
            () => db.sessionTurn.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it('denies a captured manager roster after capability downgrade during its snapshot', async () => {
        const fixture = await createSharedSessionFixture();
        const share = { sessionId_sharedWithUserId: { sessionId: fixture.sessionId, sharedWithUserId: fixture.collaboratorId } };
        await db.sessionShare.update({ where: share, data: { accessLevel: 'admin' } });
        const params = { actorAccountId: fixture.collaboratorId, sessionId: fixture.sessionId,
            authentication: createPresentUserSessionAccessAuthentication() };
        expect(await inspectSessionAccessGrants(params)).toMatchObject({ ok: true, value: { visibility: 'complete' } });
        const reader = await withSqliteReadSnapshot(async tx => tx);
        const delegate = reader.session;
        const original = delegate.findUniqueOrThrow.bind(delegate);
        const reached = deferred();
        const release = deferred();
        let paused = false;
        Object.defineProperty(delegate, 'findUniqueOrThrow', { configurable: true, writable: true,
            value: async (...args: Parameters<typeof original>) => {
                if (!paused && args[0]?.select?.shares) { paused = true; reached.resolve(); await release.promise; }
                return await original(...args);
            } });
        const response = inspectSessionAccessGrants(params);
        try {
            await expectBarrierEnteredBeforeResponse({ reached: reached.promise }, response);
            await db.sessionShare.update({ where: share, data: { accessLevel: 'view' } });
            release.resolve();
            const result = await response;
            expect(await inspectSessionAccessGrants(params)).toMatchObject({ ok: true, value: { visibility: 'self', grants: [] } });
            expect(result).toMatchObject({ ok: false, error: 'session_access_forbidden' });
        } finally {
            release.resolve(); await response;
            Object.defineProperty(delegate, 'findUniqueOrThrow', { configurable: true, writable: true, value: original });
        }
    });

    it.each(['downgraded', 'revoked'] as const)('readmits exact recipient access after its grant is %s during inspection', async (scenario) => {
        const fixture = await createSharedSessionFixture();
        const share = { sessionId_sharedWithUserId: { sessionId: fixture.sessionId, sharedWithUserId: fixture.collaboratorId } };
        await db.sessionShare.update({ where: share, data: { accessLevel: 'edit' } });
        const params = { actorAccountId: fixture.ownerId, sessionId: fixture.sessionId,
            recipientAccountId: fixture.collaboratorId, authentication: createPresentUserSessionAccessAuthentication() };
        const reader = await withSqliteReadSnapshot(async tx => tx);
        const delegate = reader.session;
        const original = delegate.findUniqueOrThrow.bind(delegate);
        const reached = deferred();
        const release = deferred();
        let paused = false;
        Object.defineProperty(delegate, 'findUniqueOrThrow', { configurable: true, writable: true,
            value: async (...args: Parameters<typeof original>) => {
                if (!paused && args[0]?.select?.shares) { paused = true; reached.resolve(); await release.promise; }
                return await original(...args);
            } });
        const response = inspectSessionAccessGrants(params);
        try {
            await expectBarrierEnteredBeforeResponse({ reached: reached.promise }, response);
            if (scenario === 'revoked') await revokeShare(fixture);
            else await db.sessionShare.update({ where: share, data: { accessLevel: 'view' } });
            release.resolve();
            expect(await response).toMatchObject({ ok: true, value: { visibility: 'complete', recipientAccess: {
                accountId: fixture.collaboratorId,
                effectiveAccess: scenario === 'revoked' ? null : { level: 'view', capabilities: { readTranscript: true, submitAgentInput: false } },
            } } });
        } finally {
            release.resolve(); await response;
            Object.defineProperty(delegate, 'findUniqueOrThrow', { configurable: true, writable: true, value: original });
        }
    });

    it.each(['owner', 'mode mismatch', 'revoked'] as const)('confirms fresh detail admission with one read (%s)', async (scenario) => {
        const fixture = await createSharedSessionFixture();
        await db.account.update({ where: { id: fixture.ownerId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: 'plain',
        } });
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }),
        } });
        const captured = await db.session.findUniqueOrThrow({ where: { id: fixture.sessionId },
            select: { id: true, encryptionMode: true, metadataLayoutVersion: true, ownerMetadata: true } });
        if (scenario !== 'owner') await db.account.update({ where: { id: fixture.ownerId }, data: { encryptionMode: 'e2ee' } });
        if (scenario === 'revoked') await revokeShare(fixture);
        const reader = await withSqliteReadSnapshot(async tx => tx);
        const reads: string[] = [];
        const restores: Array<() => void> = [];
        // Count genuine DB delegate reads and preserve the real admission/privacy owners.
        for (const model of ['session', 'account'] as const) {
            for (const method of ['findUnique', 'findMany'] as const) {
                const delegate = reader[model];
                const original = Reflect.get(delegate, method) as (...args: unknown[]) => Promise<unknown>;
                Object.defineProperty(delegate, method, { configurable: true, writable: true,
                    value: async (...args: unknown[]) => {
                        reads.push(`${model}.${method}`);
                        return await Reflect.apply(original, delegate, args);
                    } });
                // Prisma delegate methods are virtual: deleting an intercepted
                // property does not restore the proxy's method on the next case.
                restores.push(() => Object.defineProperty(delegate, method, {
                    configurable: true, writable: true, value: original,
                }));
            }
        }
        try {
            const admission = withSqliteReadSnapshot(tx => readmitSessionRowsWithAdmissionInTx(tx, {
                accountId: scenario === 'revoked' ? fixture.collaboratorId : fixture.ownerId,
                authentication: createPresentUserSessionAccessAuthentication(), accessMode: 'effective_access_v1',
            }, [captured]));
            if (scenario === 'mode mismatch') await expect(admission).rejects.toBeInstanceOf(SessionMetadataPrivacyUpgradeRequiredError);
            else expect((await admission).get(fixture.sessionId)).toMatchObject({ status: scenario === 'owner' ? 'allowed' : 'unavailable' });
            expect(reads).toEqual(['session.findMany']);
        } finally { for (const restore of restores) restore(); }
    });

    it.each(['plain', 'e2ee'] as const)('confirms %s owner session detail with one fresh Session or Account delegate read and one ciphertext scan', async (accountMode) => {
        const fixture = await createSharedSessionFixture();
        await db.account.update({ where: { id: fixture.ownerId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: accountMode,
        } });
        const ciphertext = 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==';
        const ownerMetadata = accountMode === 'plain'
            ? { t: 'plain', v: { v: 1 } } : { t: 'encrypted', c: ciphertext };
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify(ownerMetadata),
        } });
        await withAuthenticatedTestApp(app => sessionRoutes(app), async app => {
            const reader = await withSqliteReadSnapshot(async tx => tx);
            const execute = reader.$executeRawUnsafe.bind(reader);
            const findUnique = reader.session.findUnique.bind(reader.session);
            const findMany = reader.session.findMany.bind(reader.session);
            const findAccount = reader.account.findUnique.bind(reader.account);
            const findAccounts = reader.account.findMany.bind(reader.account);
            let phase = -1;
            const confirmationReads: string[] = [];
            // Observe real persistent-database calls, without replacing admission
            // or content projection. The second BEGIN is fresh confirmation.
            Object.defineProperty(reader, '$executeRawUnsafe', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof execute>) => {
                    if (args[0] === 'BEGIN DEFERRED;') phase++;
                    return await execute(...args);
                } });
            Object.defineProperty(reader.session, 'findUnique', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof findUnique>) => {
                    if (phase === 1) confirmationReads.push('findUnique');
                    return await findUnique(...args);
                } });
            Object.defineProperty(reader.session, 'findMany', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof findMany>) => {
                    if (phase === 1) confirmationReads.push('findMany');
                    return await findMany(...args);
                } });
            Object.defineProperty(reader.account, 'findUnique', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof findAccount>) => {
                    if (phase === 1) confirmationReads.push('account.findUnique');
                    return await findAccount(...args);
                } });
            Object.defineProperty(reader.account, 'findMany', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof findAccounts>) => {
                    if (phase === 1) confirmationReads.push('account.findMany');
                    return await findAccounts(...args);
                } });
            const scan = vi.spyOn(String.prototype, 'charCodeAt');
            try {
                const result = await app.inject({ method: 'GET',
                    url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`,
                    headers: { 'x-test-user-id': fixture.ownerId, 'x-happier-account-stored-content-protocol': '4' } });
                expect(result.statusCode).toBe(200);
                expect(result.json().session).toMatchObject({ id: fixture.sessionId,
                    effectiveAccess: { level: 'owner' }, ownerMetadata });
                expect(confirmationReads).toHaveLength(1);
                expect(phase).toBe(1);
                expect(scan.mock.contexts.filter(value => value === ciphertext).length)
                    .toBe(accountMode === 'e2ee' ? ciphertext.length - 2 : 0);
            } finally {
                scan.mockRestore();
                Object.defineProperty(reader, '$executeRawUnsafe', { configurable: true, writable: true, value: execute });
                Object.defineProperty(reader.session, 'findUnique', { configurable: true, writable: true, value: findUnique });
                Object.defineProperty(reader.session, 'findMany', { configurable: true, writable: true, value: findMany });
                Object.defineProperty(reader.account, 'findUnique', { configurable: true, writable: true, value: findAccount });
                Object.defineProperty(reader.account, 'findMany', { configurable: true, writable: true, value: findAccounts });
            }
        });
    });

    it.each([
        { methodId: 'key_challenge', statusCode: 403, error: 'team_authentication_required' },
        { methodId: 'missing-method', statusCode: 503, error: 'team_authentication_unavailable' },
    ])('preserves fresh Team authentication denial ($statusCode) for captured detail', async ({ methodId, statusCode, error }) => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' });
        const fixture = await createSharedSessionFixture();
        await db.account.update({ where: { id: fixture.ownerId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: 'plain',
        } });
        await db.account.update({ where: { id: fixture.collaboratorId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: 'e2ee',
        } });
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }),
        } });
        await revokeShare(fixture);
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: fixture.collaboratorId, role: 'member', sessionAccessStartsAt: null,
        } });
        const grant = await db.sessionTeamGrant.create({ data: {
            sessionId: fixture.sessionId, teamId: team.id, accessLevel: 'view', effectiveAt: new Date(),
        } });
        try {
            await withAuthenticatedTestApp(app => sessionRoutes(app), async app => {
                const reader = await withSqliteReadSnapshot(async tx => tx);
                const original = reader.session.findUnique.bind(reader.session);
                const reached = deferred();
                const release = deferred();
                let paused = false;
                Object.defineProperty(reader.session, 'findUnique', { configurable: true, writable: true,
                    value: async (...args: Parameters<typeof original>) => {
                        const row = await original(...args);
                        if (!paused && args[0]?.where?.id === fixture.sessionId) {
                            paused = true; reached.resolve(); await release.promise;
                        }
                        return row;
                    } });
                const response = app.inject({ method: 'GET',
                    url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`,
                    headers: { 'x-test-user-id': fixture.collaboratorId,
                        'x-happier-account-stored-content-protocol': '4' } });
                try {
                    await expectBarrierEnteredBeforeResponse({ reached: reached.promise }, response);
                    await db.team.update({ where: { id: team.id }, data: {
                        authenticationPolicy: { v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId }] },
                    } });
                    release.resolve();
                    const result = await response;
                    expect(result.statusCode, result.body).toBe(statusCode);
                    expect(result.json()).toEqual({ error });
                } finally {
                    release.resolve(); await response;
                    Object.defineProperty(reader.session, 'findUnique', { configurable: true, writable: true, value: original });
                }
            });
        } finally {
            await db.sessionTeamGrant.delete({ where: { sessionId_teamId: { sessionId: grant.sessionId, teamId: grant.teamId } } });
            await db.teamMembership.delete({ where: { id: membership.id } });
            await db.team.delete({ where: { id: team.id } });
        }
    });

    it('denies metadata disclosure after share revocation during its snapshot', async () => {
        const fixture = await createSharedSessionFixture();
        await db.account.update({ where: { id: fixture.ownerId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: 'plain',
        } });
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }),
        } });
        await withAuthenticatedTestApp(app => sessionRoutes(app), async app => {
            const reader = await withSqliteReadSnapshot(async tx => tx);
            const delegate = reader.session;
            const original = delegate.findUnique.bind(delegate);
            const reached = deferred();
            const release = deferred();
            let paused = false;
            // Keep the real admission query and pause only once its snapshot is pinned.
            Object.defineProperty(delegate, 'findUnique', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof original>) => {
                    const result = await original(...args);
                    if (!paused && args[0]?.where?.id === fixture.sessionId) {
                        paused = true; reached.resolve(); await release.promise;
                    }
                    return result;
                } });
            const request = { method: 'GET' as const,
                url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`,
                headers: { 'x-test-user-id': fixture.collaboratorId, 'x-happier-account-stored-content-protocol': '4' } };
            const response = app.inject(request);
            try {
                await expectBarrierEnteredBeforeResponse({ reached: reached.promise }, response);
                await revokeShare(fixture);
                release.resolve();
                const result = await response;
                expect((await app.inject(request)).statusCode).toBe(404);
                expect(result.statusCode).toBe(404);
            } finally {
                release.resolve(); await response;
                Object.defineProperty(delegate, 'findUnique', { configurable: true, writable: true, value: original });
            }
        });
    });

    it('denies captured owner metadata after owning Account mode changes during its snapshot', async () => {
        const fixture = await createSharedSessionFixture();
        await db.account.update({ where: { id: fixture.ownerId }, data: {
            ...createSignedAccountContentBinding(), encryptionMode: 'plain',
        } });
        await db.session.update({ where: { id: fixture.sessionId }, data: {
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }),
        } });
        await withAuthenticatedTestApp(app => sessionRoutes(app), async app => {
            const request = { method: 'GET' as const,
                url: `/v2/sessions/${fixture.sessionId}?accessProjectionVersion=1`,
                headers: { 'x-test-user-id': fixture.ownerId, 'x-happier-account-stored-content-protocol': '4' } };
            expect((await app.inject(request)).statusCode).toBe(200);
            const reader = await withSqliteReadSnapshot(async tx => tx);
            const delegate = reader.session;
            const original = delegate.findUnique.bind(delegate);
            const reached = deferred();
            const release = deferred();
            let paused = false;
            Object.defineProperty(delegate, 'findUnique', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof original>) => {
                    const result = await original(...args);
                    if (!paused && args[0]?.where?.id === fixture.sessionId) {
                        paused = true; reached.resolve(); await release.promise;
                    }
                    return result;
                } });
            const response = app.inject(request);
            try {
                await expectBarrierEnteredBeforeResponse({ reached: reached.promise }, response);
                await db.account.update({ where: { id: fixture.ownerId }, data: { encryptionMode: 'e2ee' } });
                release.resolve();
                const result = await response;
                expect((await app.inject(request)).statusCode).toBe(409);
                expect(result.statusCode).toBe(409);
            } finally {
                release.resolve(); await response;
                Object.defineProperty(delegate, 'findUnique', { configurable: true, writable: true, value: original });
            }
        });
    });

    it("returns only the server-derived coarse actor for an eligible external-shareable page", async () => {
        const fixture = await createSharedSessionFixture();

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${fixture.sessionId}/messages?projection=externalShareableV1&afterSeq=0`,
                    headers: { "x-test-user-id": fixture.collaboratorId },
                });

                expect(response.statusCode).toBe(200);
                const message = response.json().messages[0];
                expect(message).toMatchObject({
                    id: fixture.messageId,
                    externalShareableActor: "collaborator",
                });
                expect(message).not.toHaveProperty("inputAdmissionReceipt");
                expect(JSON.stringify(response.json())).not.toContain(fixture.collaboratorId);
                expect(JSON.stringify(response.json())).not.toContain("sharedEditor");
            },
        );
    });

    it("keeps authenticated Account authorship when a public caller supplies the retired transcript-only hint", async () => {
        const fixture = await createSharedSessionFixture();
        await db.sessionShare.update({
            where: {
                sessionId_sharedWithUserId: {
                    sessionId: fixture.sessionId,
                    sharedWithUserId: fixture.collaboratorId,
                },
            },
            data: { accessLevel: "edit" },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: `/v2/sessions/${fixture.sessionId}/messages`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": fixture.collaboratorId,
                    },
                    payload: {
                        content: {
                            t: "plain",
                            v: { role: "user", content: { type: "text", text: "voice transcript" } },
                        },
                        localId: "voice-transcript-1",
                        messageRole: "user",
                        transcriptOnly: true,
                    },
                });

                expect(response.statusCode, response.body).toBe(200);
            },
        );

        expect(await db.sessionMessage.findUniqueOrThrow({
            where: {
                sessionId_localId: {
                    sessionId: fixture.sessionId,
                    localId: "voice-transcript-1",
                },
            },
            select: { authorAccountId: true, inputAdmissionReceipt: true },
        })).toEqual({
            authorAccountId: fixture.collaboratorId,
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedAccount",
                actorAccountId: fixture.collaboratorId,
                sessionRelationship: "sharedEditor",
            },
        });
    });

    it("does not page messages after a collaborator share is revoked before the deciding transaction", async () => {
        const fixture = await createSharedSessionFixture();
        const reached = deferred();
        const release = deferred();
        const barrier = { reached: reached.promise, release: release.resolve };

        try {
            await withAuthenticatedTestApp(
                (app) => {
                    // Pause the real authentication boundary before the route opens its
                    // read snapshot. The database and access decisions remain real.
                    const authenticate = app.authenticate;
                    app.authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
                        await authenticate(request, reply);
                        reached.resolve();
                        await release.promise;
                    };
                    sessionRoutes(app);
                },
                async (app) => {
                    const responsePromise = app.inject({
                        method: "GET",
                        url: `/v1/sessions/${fixture.sessionId}/messages?projection=externalShareableV1&afterSeq=0`,
                        headers: { "x-test-user-id": fixture.collaboratorId },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(404);
                    expect(response.json()).toEqual({ error: "Session not found" });
                },
            );
        } finally {
            barrier.release();
        }
    });

    it("does not resolve a local message after a collaborator share is revoked before the deciding transaction", async () => {
        const fixture = await createSharedSessionFixture();
        const barrier = await installPauseBeforeReadTransaction();

        try {
            await withAuthenticatedTestApp(
                (app) => sessionRoutes(app),
                async (app) => {
                    const responsePromise = app.inject({
                        method: "GET",
                        url: `/v2/sessions/${fixture.sessionId}/messages/by-local-id/${fixture.localId}`,
                        headers: { "x-test-user-id": fixture.collaboratorId },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(404);
                    expect(response.json()).toEqual({ error: "Session not found" });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it("returns unavailable rather than deleted or available after a share is revoked before action-reference lookup", async () => {
        const fixture = await createSharedSessionFixture();
        const barrier = await installPauseBeforeReadTransaction();

        try {
            await withAuthenticatedTestApp(
                (app) => sessionRoutes(app),
                async (app) => {
                    const responsePromise = app.inject({
                        method: "POST",
                        url: `/v1/sessions/${fixture.sessionId}/messages/action-reference/resolve`,
                        headers: {
                            "content-type": "application/json",
                            "x-test-user-id": fixture.collaboratorId,
                        },
                        payload: {
                            v: 1,
                            sessionId: fixture.sessionId,
                            messageId: fixture.messageId,
                            observedRevision: fixture.observedRevision,
                        },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(200);
                    expect(response.json()).toEqual({ status: "unavailable" });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it("does not project turns after a collaborator share is revoked before the deciding turn query", async () => {
        const fixture = await createSharedSessionFixture();
        const barrier = await installPauseBeforeModelRead({ model: "sessionTurn", method: "findMany" });

        try {
            await withAuthenticatedTestApp(
                (app) => sessionRoutes(app),
                async (app) => {
                    const responsePromise = app.inject({
                        method: "GET",
                        url: `/v1/sessions/${fixture.sessionId}/turns`,
                        headers: { "x-test-user-id": fixture.collaboratorId },
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();

                    const response = await responsePromise;
                    expect(response.statusCode).toBe(404);
                    expect(response.json()).toEqual({ error: "Session not found" });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it.each([
        ["local message", "findFirst", "GET", "local"],
        ["action reference", "findFirst", "POST", "reference"],
        ["message page", "findMany", "GET", "page"],
    ] as const)("does not disclose a %s after revocation before its deciding content read", async (_name, method, httpMethod, route) => {
        const fixture = await createSharedSessionFixture();
        const barrier = await installPauseBeforeModelRead({ model: "sessionMessage", method });
        const url = route === "local"
            ? `/v2/sessions/${fixture.sessionId}/messages/by-local-id/${fixture.localId}`
            : route === "reference"
                ? `/v1/sessions/${fixture.sessionId}/messages/action-reference/resolve`
                : `/v1/sessions/${fixture.sessionId}/messages?afterSeq=0`;
        try {
            await withAuthenticatedTestApp(
                app => sessionRoutes(app),
                async app => {
                    const responsePromise = app.inject({
                        method: httpMethod,
                        url,
                        headers: { "x-test-user-id": fixture.collaboratorId },
                        ...(route === "reference" ? { payload: {
                            v: 1,
                            sessionId: fixture.sessionId,
                            messageId: fixture.messageId,
                            observedRevision: fixture.observedRevision,
                        } } : {}),
                    });
                    await expectBarrierEnteredBeforeResponse(barrier, responsePromise);
                    await revokeShare(fixture);
                    barrier.release();
                    const response = await responsePromise;
                    expect(response.statusCode).toBe(route === "reference" ? 200 : 404);
                    expect(response.json()).toEqual(route === "reference"
                        ? { status: "unavailable" }
                        : { error: "Session not found" });
                },
            );
        } finally {
            barrier.restore();
        }
    });

    it.each([
        ["owner", (fixture: Awaited<ReturnType<typeof createSharedSessionFixture>>) => fixture.ownerId],
        ["shared recipient", (fixture: Awaited<ReturnType<typeof createSharedSessionFixture>>) => fixture.collaboratorId],
    ])("keeps the %s turns projection at the server publication ceiling without a client projection query", async (_recipient, resolveUserId) => {
        const fixture = await createSharedSessionFixture();
        const publicationObservedAt = 1_700_000_000_000;
        const privateUpdatedAt = new Date(publicationObservedAt + 60_000);
        await db.sessionTurn.update({
            where: {
                sessionId_turnId: {
                    sessionId: fixture.sessionId,
                    turnId: "turn-1",
                },
            },
            data: {
                transcriptAnchorsJson: JSON.stringify({
                    startUserMessageSeq: 1,
                    userMessageSeqs: [1],
                    startSeqInclusive: 1,
                    endSeqInclusive: 1,
                    finalAssistantMessageSeq: 1,
                }),
            },
        });
        await db.sessionTurn.create({
            data: {
                sessionId: fixture.sessionId,
                turnId: "turn-private-tail",
                status: "completed",
                startedAt: 2n,
                updatedAt: 3n,
                transcriptAnchorsJson: JSON.stringify({
                    startUserMessageSeq: 2,
                    userMessageSeqs: [2],
                    startSeqInclusive: 2,
                    endSeqInclusive: 2,
                    finalAssistantMessageSeq: 2,
                }),
            },
        });
        await db.session.update({
            where: { id: fixture.sessionId },
            data: {
                seq: 2,
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 2,
                materializationPublicationId: "publication-current-membership",
                materializedThroughSourceAt: BigInt(publicationObservedAt),
                publishedThroughServerSeq: 1,
                latestTurnId: "turn-private-tail",
                updatedAt: privateUpdatedAt,
            },
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${fixture.sessionId}/turns`,
                    headers: { "x-test-user-id": resolveUserId(fixture) },
                });

                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({
                    v: 1,
                    sessionId: fixture.sessionId,
                    updatedAt: publicationObservedAt,
                    turns: [expect.objectContaining({ turnId: "turn-1" })],
                });
            },
        );
    });

    it("rejects the retired external-shareable turns projection", async () => {
        const fixture = await createSharedSessionFixture();

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${fixture.sessionId}/turns?projection=externalShareableV1`,
                    headers: { "x-test-user-id": fixture.collaboratorId },
                });

                expect(response.statusCode).toBe(400);
            },
        );
    });
});
