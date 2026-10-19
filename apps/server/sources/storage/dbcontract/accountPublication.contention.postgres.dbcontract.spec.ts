import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerConnectedAccountConfigurationRowsRoutes } from "@/app/account/connectedAccounts/registerConfigurationRowsRoutes";
import { registerSessionArchiveRoutes } from "@/app/api/routes/session/registerSessionArchiveRoutes";
import { registerSessionManagerRoutes } from "@/app/api/routes/session/registerSessionManagerRoutes";
import { registerSessionFollowRoutes } from "@/app/api/routes/session/registerSessionFollowRoutes";
import { registerSessionFollowSourceRoutes } from "@/app/api/routes/session/registerSessionFollowSourceRoutes";
import { applyViewerReadCursorOperation } from "@/app/session/personal/readState";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { SessionManagerSetResultV1Schema } from "@happier-dev/protocol/sessions/follow/sessionManagerV1";
import { ChangeDeliveryMuteResponseV1Schema, ListDeliveryMutesResponseV1Schema } from "@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import type { Tx } from "@/storage/inTx";
import { mutateQualifiedConnectedServiceCredential } from "@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository";
import { createQualifiedConnectedAccountGroup } from "@/app/api/routes/connect/qualifiedConnectedAccounts/groupRepository";
import { initEncrypt } from "@/modules/encrypt";
import { ConnectedAccountCatalogRowMutationResponseV1Schema, CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from "@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1";
import { registerConfiguredAgentRowsRoutes } from "@/app/account/agents/registerConfiguredAgentRowsRoutes";
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowMutationResponseV1Schema } from "@happier-dev/protocol/acp/catalog/catalogRowsV1";
import { readHomeDomainConfirmedRollbackV1 } from "@happier-dev/protocol/actions/homeDomainHttpBinding";
import { registerPromptLibraryRoutes } from "@/app/account/prompts/registerPromptLibraryRoutes";
import { registerAccountSettingsHistoryRoutes } from "@/app/api/routes/account/registerAccountSettingsHistoryRoutes";
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, buildPromptLibraryPhysicalKeyV1, PromptLibraryRowMutationResponseV1Schema,
    PromptLibraryRowReadResponseV1Schema, PromptLibraryRowsListResponseV1Schema } from "@happier-dev/protocol/prompts/library/promptLibraryRowsV1";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Account publication transaction admission", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        process.env.HANDY_MASTER_SECRET ??= "r11-disposable-contract";
        await initEncrypt();
    });
    afterAll(async () => { await db.$disconnect(); });

    it("keeps the ACP row CAS authoritative for concurrent definition writes", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        await withAuthenticatedTestApp(registerConfiguredAgentRowsRoutes, async app => {
            const headers = { "x-test-user-id": account.id };
            const payload = { expectedRevision: "absent", source: "fresh", sourceSettingsVersion: 0,
                referencedSavedSecretIds: [], content: { t: "plain", v: { v: 1, definitions: [] } } };
            const responses = await Promise.all([1, 2].map(() => app.inject({ method: "POST",
                url: ACP_CATALOG_ROWS_ROUTE_V1, headers, payload })));
            expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
            expect(responses.map(response => AcpCatalogRowMutationResponseV1Schema.parse(response.json()).status).sort())
                .toEqual(["conflict", "updated"]);
            const read = await app.inject({ method: "GET", url: ACP_CATALOG_ROWS_ROUTE_V1, headers });
            expect(read.json()).toEqual({ status: "present", revision: 0, content: payload.content });
        });
    });

    it("keeps the prompt row CAS authoritative for concurrent catalog writes", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        await withAuthenticatedTestApp(registerPromptLibraryRoutes, async app => {
            const headers = { "x-test-user-id": account.id };
            const url = `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`;
            const payload = { expectedRevision: "absent", sourceSettingsVersion: 0,
                content: { t: "plain", v: { key: "skill-rules", value: { v: 1, rules: [] } } } };
            const responses = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url, headers, payload })));
            expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
            expect(responses.map(response => PromptLibraryRowMutationResponseV1Schema.parse(response.json()).status).sort())
                .toEqual(["conflict", "updated"]);
            const read = await app.inject({ method: "GET", url, headers });
            expect(PromptLibraryRowReadResponseV1Schema.parse(read.json())).toEqual({ status: "present", revision: 0, content: payload.content });
        });
    });

    it.each(["configuration", "acp", "prompt-row", "prompt-list", "settings-history-list", "settings-history-row"] as const)("captures %s reads coherently without joining the SSI predicate graph", async catalog => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        if (catalog.startsWith("settings-history")) {
            await db.accountSettingsSnapshot.create({ data: { accountId: account.id, version: 0,
                encryptionMode: "plain", settingsDbValue: null, contentKind: "empty" } });
        }
        const transaction = db.$transaction;
        const locked = deferred(), release = deferred();
        const peer = Reflect.apply(transaction, db, [async (tx: Tx) => {
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            locked.resolve();
            await release.promise;
        }, { isolationLevel: "Serializable" }]) as Promise<unknown>;
        await locked.promise;
        let predicateLocks = -1;
        let attempts = 0;
        const locksObserved = deferred();
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                attempts++;
                const result = await callback(tx);
                const [{ count }] = await tx.$queryRaw<Array<{ count: number }>>`
                    SELECT count(*)::int AS count FROM pg_locks
                    WHERE pid = pg_backend_pid() AND mode = 'SIReadLock'
                `;
                predicateLocks = count;
                locksObserved.resolve();
                return result;
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(app => {
                registerConfiguredAgentRowsRoutes(app);
                registerConnectedAccountConfigurationRowsRoutes(app);
                registerPromptLibraryRoutes(app);
                registerAccountSettingsHistoryRoutes(app);
            }, async app => {
                const url = catalog === "acp" ? ACP_CATALOG_ROWS_ROUTE_V1
                    : catalog === "prompt-row" ? `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`
                    : catalog === "prompt-list" ? PROMPT_LIBRARY_ROWS_ROUTE_V1
                    : catalog === "settings-history-list" ? "/v2/account/settings/history"
                    : catalog === "settings-history-row" ? "/v2/account/settings/history/0"
                    : `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`;
                const response = await app.inject({ method: "GET",
                    url, headers: { "x-test-user-id": account.id } });
                expect(response.statusCode).toBe(200);
                if (catalog === "prompt-list") expect(PromptLibraryRowsListResponseV1Schema.parse(response.json())).toEqual({ status: "listed", rows: [] });
                else if (catalog === "prompt-row") expect(PromptLibraryRowReadResponseV1Schema.parse(response.json())).toEqual({ status: "absent" });
                else if (catalog === "settings-history-list") expect(response.json()).toMatchObject({ snapshots: [{ version: 0 }] });
                else if (catalog === "settings-history-row") expect(response.json()).toMatchObject({ version: 0, content: null });
                else expect(response.json()).toEqual({ status: "absent" });
                // A route may send its captured result before inTx finishes.
                await locksObserved.promise;
                expect(predicateLocks).toBe(0);
                expect(attempts).toBe(1);
            });
        } finally {
            release.resolve();
            db.$transaction = transaction;
            await peer;
        }
    });

    it.each(["prompt-row", "prompt-list", "settings-history-row", "settings-history-list"] as const)(
        "keeps %s in the Account capture when a publisher commits between reads", async catalog => {
            const account = await db.account.create({ data: { encryptionMode: "plain" } });
            const prompt = catalog.startsWith("prompt");
            const transaction = db.$transaction;
            await withAuthenticatedTestApp(app => { registerPromptLibraryRoutes(app); registerAccountSettingsHistoryRoutes(app); }, async app => {
                const headers = { "x-test-user-id": account.id };
                if (prompt) {
                    const response = await app.inject({ method: "POST", url: `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`, headers,
                        payload: { expectedRevision: "absent", sourceSettingsVersion: 0,
                            content: { t: "plain", v: { key: "skill-rules", value: { v: 1, rules: [] } } } } });
                    expect(response.statusCode).toBe(200);
                    expect(PromptLibraryRowMutationResponseV1Schema.parse(response.json()).status).toBe("updated");
                } else {
                    await db.accountSettingsSnapshot.create({ data: { accountId: account.id, version: 0,
                        encryptionMode: "plain", settingsDbValue: null, contentKind: "empty" } });
                }
                let published = false;
                // Schedule a real committed publication after Account admission,
                // before the catalog/history SELECT. ReadCommitted would mix revisions.
                db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                        if (property !== "account") return Reflect.get(inner, property, innerReceiver);
                        return new Proxy(inner.account, { get(model, method, modelReceiver) {
                            if (method !== "findUnique") return Reflect.get(model, method, modelReceiver);
                            return async (...queryArgs: unknown[]) => {
                                const captured = await Reflect.apply(model.findUnique, model, queryArgs);
                                if (!published) {
                                    published = true;
                                    await Reflect.apply(transaction, db, [async (peer: Tx) => {
                                        await peer.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                                        if (prompt) await peer.userKVStore.update({ where: { accountId_key: {
                                            accountId: account.id, key: buildPromptLibraryPhysicalKeyV1("skill-rules") } }, data: { version: 1 } });
                                        else await peer.accountSettingsSnapshot.update({ where: { accountId_version: {
                                            accountId: account.id, version: 0 } }, data: { version: 1 } });
                                    }]);
                                }
                                return captured;
                            };
                        } });
                    } })), ...args.slice(1)]);
                } });
                try {
                    const response = await app.inject({ method: "GET", headers, url: catalog === "prompt-row"
                        ? `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules` : catalog === "prompt-list" ? PROMPT_LIBRARY_ROWS_ROUTE_V1
                        : catalog === "settings-history-row" ? "/v2/account/settings/history/0" : "/v2/account/settings/history" });
                    expect(response.statusCode).toBe(200);
                    expect(published).toBe(true);
                    if (catalog === "prompt-row") expect(PromptLibraryRowReadResponseV1Schema.parse(response.json())).toMatchObject({ status: "present", revision: 0 });
                    else if (catalog === "prompt-list") expect(PromptLibraryRowsListResponseV1Schema.parse(response.json())).toMatchObject({ rows: [{ revision: 0 }] });
                    else if (catalog === "settings-history-row") expect(response.json()).toMatchObject({ version: 0 });
                    else expect(response.json()).toMatchObject({ snapshots: [{ version: 0 }] });
                } finally { db.$transaction = transaction; }
            });
        },
    );

    it.each(["configuration", "mode-change", "archive", "archive-active", "unarchive", "credential", "credential-mode-change", "group", "acp", "acp-mode-change", "acp-reference", "prompt", "prompt-mode-change",
        "manager", "manager-cas", "manager-inactive", "follow", "follow-remove", "voice", "follow-preferences", "follow-source", "follow-source-remove", "read-mark-read", "read-mark-unread", "read-advance",
        "delivery-mute", "delivery-mute-remove", "delivery-mute-inactive"] as const)(
        "settles %s after a held Account writer commits", async operation => {
            const account = await db.account.create({ data: { encryptionMode: "plain" } });
            const relationOperation = operation.startsWith("manager") || operation.startsWith("follow")
                || operation === "voice" || operation.startsWith("read-") || operation.startsWith("delivery-mute");
            const session = operation === "archive" || operation === "archive-active" || operation === "unarchive"
                || relationOperation
                ? await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}",
                    encryptionMode: "plain", active: false, seq: 10, archivedAt: operation === "unarchive" ? new Date(123) : null } })
                : null;
            const lead = relationOperation ? await db.session.create({ data: { accountId: account.id,
                tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: false } }) : null;
            if (session && operation === "manager-cas") await db.sessionFollowEdge.create({ data: {
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: session.id }),
                sourceSessionId: session.id, destinationSessionId: lead!.id, relation: 'manager', managerSourceSessionId: session.id,
                policyJson: JSON.stringify({ preset: 'important' }),
            } });
            if (session && operation === "follow-remove") await db.accountSessionFollow.create({ data: {
                accountId: account.id, sessionId: session.id, following: true, notificationLevel: "none", includeInVoice: false,
            } });
            if (session && operation === "follow-source-remove") await db.sessionFollowEdge.create({ data: {
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: session.id }),
                sourceSessionId: session.id, destinationSessionId: lead!.id, policyJson: JSON.stringify({ preset: 'quiet' }),
            } });
            if (session && operation.startsWith("read-")) await db.accountSessionReadState.create({ data: {
                accountId: account.id, sessionId: session.id, lastViewedSessionSeq: operation === "read-mark-unread" ? 10 : 0,
            } });
            const transaction = db.$transaction;
            let attempts = 0;
            let waits = 0;
            const failures: string[] = [];
            if (session && operation === "delivery-mute-remove") await db.account.update({
                where: { id: account.id }, data: { deliveryMutes: JSON.stringify([{ kind: "sender_session", sessionId: session.id }]) },
            });
            // Only the Prisma transport is scheduled. HTTP, mode admission,
            // Account fences, lifecycle effects and publication execute unchanged.
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    let interleaved = false;
                    const interleave = async <T>(run: () => Promise<T>): Promise<T> => {
                        if (interleaved) return run();
                        interleaved = true;
                        attempts++;
                        const locked = deferred(), release = deferred();
                        const peer = Reflect.apply(transaction, db, [async (peerTx: Tx) => {
                            await peerTx.account.update({ where: { id: account.id }, data: operation === "mode-change" || operation.endsWith("-mode-change")
                                ? { encryptionMode: "e2ee", ...createSignedAccountContentBinding() }
                                : operation === "manager-inactive" || operation === "delivery-mute-inactive" ? { status: "disabled", seq: { increment: 1 } }
                                : { seq: { increment: 1 } } });
                            if (operation === "archive-active" && session) {
                                await peerTx.session.update({ where: { id: session.id }, data: { active: true } });
                            }
                            locked.resolve();
                            await release.promise;
                        }]) as Promise<unknown>;
                        await locked.promise;
                        const waiting = Promise.resolve(run());
                        // Attach immediately while PostgreSQL's actual wait is observed.
                        void waiting.catch(() => undefined);
                        try {
                            for (;;) {
                                const [{ waiting: blocked }] = await db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
                                    `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                        AND wait_event_type = 'Lock' AND query LIKE '%"Account"%') AS waiting`,
                                );
                                if (blocked) { waits++; break; }
                            }
                        } finally { release.resolve(); }
                        await peer;
                        try { return await waiting; }
                        catch (error) {
                            failures.push(typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown");
                            throw error;
                        }
                    };
                    return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                        if (property === "account") return new Proxy(inner.account, { get(model, method, modelReceiver) {
                            if (method !== "update") return Reflect.get(model, method, modelReceiver);
                            return (...queryArgs: unknown[]) => interleave(() => Reflect.apply(model.update, model, queryArgs));
                        } });
                        if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                        return (query: string, ...values: unknown[]) => {
                            const run = () => inner.$queryRawUnsafe(query, ...values);
                            return query.includes('FROM "Account"') && query.includes("FOR ") || query.includes('UPDATE "Account"')
                                ? interleave(run) : run();
                        };
                    } }));
                }, ...args.slice(1)]);
            } });
            try {
                await withAuthenticatedTestApp(app => {
                    registerConnectedAccountConfigurationRowsRoutes(app);
                    registerSessionArchiveRoutes(app);
                    registerSessionManagerRoutes(app);
                    registerSessionFollowRoutes(app);
                    registerSessionFollowSourceRoutes(app);
                    registerConfiguredAgentRowsRoutes(app);
                    registerPromptLibraryRoutes(app);
                }, async app => {
                    const startedAt = Date.now();
                    if (operation.startsWith("delivery-mute") && session) {
                        const scope = { kind: "sender_session", sessionId: session.id };
                        const removing = operation === "delivery-mute-remove";
                        const inactive = operation === "delivery-mute-inactive";
                        const response = await app.inject({ method: removing ? "DELETE" : "PUT",
                            url: "/v2/account/session-delivery-mutes",
                            headers: { "x-test-user-id": account.id }, payload: { scope },
                        });
                        console.info("B4_DELIVERY_MUTE_PUBLICATION", { operation, attempts, waits, failures, status: response.statusCode });
                        expect(response.statusCode).toBe(inactive ? 403 : 200);
                        if (inactive) {
                            expect(response.json()).toEqual({ error: "account_inactive" });
                            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).deliveryMutes).toBeNull();
                        } else {
                            expect(ChangeDeliveryMuteResponseV1Schema.parse(response.json())).toEqual({
                                changed: true, disposition: removing ? "unmuted" : "muted",
                            });
                            const read = await app.inject({ method: "GET", url: "/v2/account/session-delivery-mutes",
                                headers: { "x-test-user-id": account.id } });
                            expect(read.statusCode).toBe(200);
                            expect(ListDeliveryMutesResponseV1Schema.parse(read.json())).toEqual({ scopes: removing ? [] : [scope] });
                        }
                        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(inactive ? 1 : 2);
                        expect(waits).toBeGreaterThan(0);
                        expect(failures).toEqual([]);
                        expect(attempts).toBe(1);
                        return;
                    }
                    if (relationOperation && session && lead) {
                        const manager = operation.startsWith("manager");
                        const source = operation.startsWith("follow-source");
                        if (operation.startsWith("read-")) {
                            const result = await applyViewerReadCursorOperation({ accountId: account.id, sessionId: session.id,
                                authentication: createPresentUserSessionAccessAuthentication({ env: {} }),
                                operation: operation === "read-mark-read" ? { kind: "mark-read" }
                                    : operation === "read-mark-unread" ? { kind: "mark-unread" }
                                    : { kind: "advance", lastViewedSessionSeq: 5 },
                            });
                            console.info("R27_READ_PUBLICATION", { operation, attempts, waits, failures,
                                ok: result.ok, durationMs: Date.now() - startedAt });
                            expect(result).toMatchObject({ ok: true });
                            const frontier = await db.accountSessionReadState.findUniqueOrThrow({ where: {
                                accountId_sessionId: { accountId: account.id, sessionId: session.id },
                            } });
                            expect(frontier.lastViewedSessionSeq).toBe(operation === "read-mark-read" ? 10 : operation === "read-advance" ? 5 : 9);
                            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBeGreaterThan(1);
                            expect(waits).toBeGreaterThan(0);
                            expect(failures).toEqual([]);
                            expect(attempts).toBe(1);
                            return;
                        }
                        const response = await app.inject({
                            method: operation.endsWith("-remove") ? "DELETE" : manager ? "POST" : "PUT",
                            url: manager ? `/v1/sessions/${session.id}/manager`
                                : source ? `/v2/sessions/${lead.id}/follows/sessions/${session.id}`
                                : operation === "voice" ? "/v2/account/session-follow-voice-inclusions"
                                : operation === "follow-preferences" ? "/v2/account/session-follow-preferences"
                                : `/v2/sessions/${session.id}/follow`,
                            headers: { "x-test-user-id": account.id },
                            ...(operation.endsWith("-remove") ? {} : { payload: manager
                                ? { managerSessionId: operation === "manager-cas" ? null : lead.id, expectedManagerSessionId: null }
                                : source ? { policy: { preset: 'quiet' } }
                                : operation === "voice" ? { sessionIds: [session.id] }
                                : operation === "follow-preferences" ? { assigned: false, direct: false, team: false, group: false }
                                : { notificationLevel: "important", includeInVoice: false } }),
                        });
                        console.info("R27_RELATION_PUBLICATION", { operation, attempts, waits, failures,
                            status: response.statusCode, durationMs: Date.now() - startedAt });
                        expect(response.statusCode).toBe(operation === "manager-cas" ? 409 : operation === "manager-inactive" ? 403 : 200);
                        if (operation === "manager-inactive") {
                            expect(SessionManagerSetResultV1Schema.parse(response.json())).toEqual({ ok: false, error: "manager_forbidden", reason: "read" });
                            expect(await db.sessionFollowEdge.count({ where: { managerSourceSessionId: session.id } })).toBe(0);
                            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(1);
                            expect(waits).toBeGreaterThan(0);
                            expect(failures).toEqual([]);
                            expect(attempts).toBe(1);
                            return;
                        }
                        if (manager) {
                            expect(SessionManagerSetResultV1Schema.parse(response.json())).toMatchObject(operation === "manager-cas"
                                ? { ok: false, error: "manager_cas_conflict" } : { ok: true, managerSessionId: lead.id });
                            expect(await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: session.id } }))
                                .toMatchObject({ relation: 'manager', destinationSessionId: lead.id });
                        } else if (source) {
                            expect(await db.sessionFollowEdge.count({ where: { destinationSessionId: lead.id, sourceSessionId: session.id } }))
                                .toBe(operation === "follow-source-remove" ? 0 : 1);
                        } else if (operation === "follow-preferences") {
                            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
                                sessionAutoFollowAssigned: false, sessionAutoFollowDirect: false,
                                sessionAutoFollowTeam: false, sessionAutoFollowGroup: false,
                            });
                        } else {
                            expect(await db.accountSessionFollow.findUniqueOrThrow({ where: {
                                accountId_sessionId: { accountId: account.id, sessionId: session.id },
                            } })).toMatchObject({ following: operation !== "follow-remove", includeInVoice: operation === "voice" });
                        }
                        const committedCursor = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
                        if (operation === "manager-cas") expect(committedCursor).toBe(1);
                        else expect(committedCursor).toBeGreaterThan(1);
                        expect(waits).toBeGreaterThan(0);
                        expect(failures).toEqual([]);
                        expect(attempts).toBe(1);
                        return;
                    }
                    if (operation === "group" || operation === "credential" || operation === "credential-mode-change") {
                        const service = { pluginId: "fixture.r11", localId: "account-publication" };
                        const result = operation === "group"
                            ? await createQualifiedConnectedAccountGroup({ accountId: account.id, service, group: { groupId: "owned" } })
                            : await mutateQualifiedConnectedServiceCredential({ accountId: account.id,
                                ref: { service, accountId: "owned" }, expectedCredentialRevision: null,
                                authenticationModeId: "oauth", content: { t: "plain", v: { fixture: true } }, metadata: { scopes: [] } });
                        console.info("R11_ACCOUNT_PUBLICATION", { operation, attempts, waits, failures,
                            status: result.status, durationMs: Date.now() - startedAt });
                        expect(result.status).toBe(operation === "credential-mode-change" ? "storage_mode_mismatch" : "written");
                        if (operation === "credential-mode-change") {
                            expect(await db.serviceAccountToken.count({ where: { accountId: account.id } })).toBe(0);
                        }
                        expect(waits).toBeGreaterThan(0);
                        expect(failures).toEqual([]);
                        expect(attempts).toBe(1);
                        return;
                    }
                    const acp = operation.startsWith("acp");
                    const prompt = operation.startsWith("prompt");
                    const response = await app.inject({ method: "POST",
                        url: session ? `/v2/sessions/${session.id}/${operation === "archive-active" ? "archive" : operation}` : acp ? ACP_CATALOG_ROWS_ROUTE_V1
                            : prompt ? `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules` : `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`,
                        headers: { "x-test-user-id": account.id },
                        ...(session ? {} : { payload: { expectedRevision: "absent", sourceSettingsVersion: 0,
                            ...(acp ? { source: "fresh" } : {}),
                            referencedSavedSecretIds: operation === "acp-reference" ? ["happier:shared-secret:v1:held-reference"] : [],
                            content: { t: "plain", v: acp ? { v: 1, definitions: [] }
                                : prompt ? { key: "skill-rules", value: { v: 1, rules: [] } } : { key: "configurations", value: { v: 1, entries: [] } } } } }),
                    });
                    console.info("R11_ACCOUNT_PUBLICATION", { operation, attempts, waits, failures,
                        status: response.statusCode, durationMs: Date.now() - startedAt });
                    if (operation === "archive-active" && session) {
                        expect(response.statusCode).toBe(409);
                        expect(response.json()).toEqual({ error: "session-active" });
                        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
                            .toMatchObject({ active: true, archivedAt: null });
                        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(1);
                        expect(waits).toBeGreaterThan(0);
                        expect(failures).toEqual([]);
                        expect(attempts).toBe(1);
                        return;
                    }
                    if (operation === "acp-reference") {
                        // A referenced grant can change under another Account. Its
                        // retained SSI rollback must reach the canonical HTTP error owner.
                        expect(response.statusCode).toBe(503);
                        expect(response.json()).toMatchObject({ error: "database_transaction_conflict_exhausted", statusCode: 503 });
                        expect(readHomeDomainConfirmedRollbackV1(response.statusCode, response.json())?.code)
                            .toBe("database_transaction_conflict_exhausted");
                        expect(failures.length).toBeGreaterThan(0);
                        expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
                        return;
                    }
                    expect(response.statusCode).toBe(200);
                    if (session) {
                        expect(response.json()).toMatchObject({ success: true });
                        expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).archivedAt === null)
                            .toBe(operation === "unarchive");
                        // The lifecycle write must commit its recipient cursor as
                        // well as its state after the unrelated publisher releases.
                        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq)
                            .toBeGreaterThanOrEqual(2);
                    } else {
                        const modeChanged = operation === "mode-change" || operation.endsWith("-mode-change");
                        expect((acp ? AcpCatalogRowMutationResponseV1Schema : prompt ? PromptLibraryRowMutationResponseV1Schema : ConnectedAccountCatalogRowMutationResponseV1Schema).parse(response.json())).toMatchObject(
                            modeChanged ? { status: "account-mode-mismatch" } : { status: "updated", revision: 0 },
                        );
                        expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(modeChanged ? 0 : 1);
                    }
                    expect(waits).toBeGreaterThan(0);
                    expect(failures).toEqual([]);
                    expect(attempts).toBe(1);
                });
            } finally { db.$transaction = transaction; }
        },
    );
});
