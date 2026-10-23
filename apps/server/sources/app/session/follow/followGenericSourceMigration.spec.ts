import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { FollowPolicyV1Schema, resolveFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { normalizeAccountFollowNotificationChoiceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';

const migrations = resolve(import.meta.dirname, '../../../../prisma/sqlite/migrations');
const genericMigration = '20261019150000_account_follow_generic_sources';
const postgresMigrations = resolve(migrations, '../../migrations');
const policyContractionMigration = '20261022140000_account_follow_policy_only';
const sourceIdentityMigration = '20261023233000_account_follow_source_identity_required';

describe('generic Follow source storage upgrade', () => {
    it.each(['sqlite', 'postgres'] as const)('contracts legacy notification levels into policy without losing private custody (%s)', async provider => {
        const database = provider === 'sqlite' ? new DatabaseSync(':memory:') : new PGlite();
        const execute = async (sql: string) => { await database.exec(sql); };
        const query = async (sql: string) => database instanceof DatabaseSync
            ? database.prepare(sql).all() : (await database.query<Record<string, unknown>>(sql)).rows;
        const root = provider === 'sqlite' ? migrations : postgresMigrations;
        try {
            if (database instanceof PGlite) await database.waitReady;
            await execute(`CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Session" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Discussion" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY);
                INSERT INTO "Account" VALUES ('account');`);
            for (const name of ['20260906120000_add_account_session_follows', '20261018120000_account_follow_personal_once',
                genericMigration, '20261021045500_personal_run_permission_progress']) {
                await execute(readFileSync(resolve(root, name, 'migration.sql'), 'utf8'));
            }
            for (const [id, level, voice, following, persistent, policy] of [
                ['important', 'important', false, true, true, null],
                ['everything', 'all_messages', false, true, true, null],
                ['quiet', 'none', false, true, true, null],
                ['voice-only', 'none', true, true, true, null],
                ['important-voice', 'important', true, true, true, null],
                ['modern', 'all_messages', true, true, true, '{"preset":"quiet"}'],
                ['suppressed', 'none', false, false, true, null],
                ['once-only', 'important', false, false, false, null],
            ] as const) {
                await execute(`INSERT INTO "Session" VALUES ('${id}');
                    INSERT INTO "AccountSessionFollow" ("id", "accountId", "sessionId", "sourceKey", "following",
                        "hasPersistentFollow", "notificationLevel", "includeInVoice", "voiceDeliveredFrontier", "followPolicy", "notifyOnce")
                    VALUES ('${id}', 'account', '${id}', 'session:${id}', ${following}, ${persistent}, '${level}', ${voice},
                        'voice-frontier', ${policy === null ? 'NULL' : `'${policy}'`}, '{"kind":"first_needs_you"}');`);
            }
            const path = resolve(root, policyContractionMigration, 'migration.sql');
            await execute(readFileSync(path, 'utf8'));
            const identityPath = resolve(root, sourceIdentityMigration, 'migration.sql');
            await execute(readFileSync(identityPath, 'utf8'));
            const rows = await query('SELECT * FROM "AccountSessionFollow" ORDER BY "id"');
            expect(rows).toHaveLength(8);
            for (const row of rows) {
                expect(row).not.toHaveProperty('notificationLevel');
                expect(row.voiceDeliveredFrontier).toBe('voice-frontier');
                expect(row.notifyOnce).toBe('{"kind":"first_needs_you"}');
                expect(Boolean(row.includeInVoice)).toBe(false);
            }
            const byId = new Map(rows.map(row => [row.id, row]));
            expect(JSON.parse(String(byId.get('important')?.followPolicy))).toEqual({ preset: 'important' });
            expect(JSON.parse(String(byId.get('everything')?.followPolicy))).toEqual({ preset: 'everything' });
            expect(JSON.parse(String(byId.get('quiet')?.followPolicy))).toEqual({ preset: 'custom', events: {} });
            expect(byId.get('modern')?.followPolicy).toBe('{"preset":"quiet"}');
            expect(byId.get('suppressed')?.followPolicy).toBeNull();
            expect(Boolean(byId.get('suppressed')?.following)).toBe(false);
            expect(Boolean(byId.get('once-only')?.hasPersistentFollow)).toBe(false);
            expect(byId.get('once-only')?.followPolicy).toBeNull();
            for (const id of ['voice-only', 'important-voice']) {
                const policy = FollowPolicyV1Schema.parse(JSON.parse(String(byId.get(id)?.followPolicy)));
                expect(policy).toEqual(normalizeAccountFollowNotificationChoiceV1({
                    notificationLevel: id === 'voice-only' ? 'none' : 'important', includeInVoice: true,
                }));
                expect(resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'message' } }).person)
                    .toEqual({ inbox: false, push: false, voice: true });
                expect(resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'finished' } }).person)
                    .toEqual({ inbox: id === 'important-voice', push: false, voice: true });
            }
        } finally {
            await database.close();
        }
    });
    it.each(['sqlite', 'postgres'] as const)('preserves personal custody and enforces source identity after the full Follow migration chain (%s)', async provider => {
        const database = provider === 'sqlite' ? new DatabaseSync(':memory:') : new PGlite();
        const execute = async (sql: string) => { await database.exec(sql); };
        const query = async (sql: string) => database instanceof DatabaseSync
            ? database.prepare(sql).all() : (await database.query<Record<string, unknown>>(sql)).rows;
        const root = provider === 'sqlite' ? migrations : postgresMigrations;
        const migrate = async (name: string) => { await execute(readFileSync(resolve(root, name, 'migration.sql'), 'utf8')); };
        try {
            if (database instanceof PGlite) await database.waitReady;
            else database.exec('PRAGMA foreign_keys = ON;');
            await execute(`CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Session" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Discussion" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY);
                INSERT INTO "Account" VALUES ('account');
                INSERT INTO "Session" VALUES ('same-id'), ('legacy-null');
                INSERT INTO "Discussion" VALUES ('same-id');
                INSERT INTO "AutomationRun" VALUES ('same-id');`);
            await migrate('20260906120000_add_account_session_follows');
            await migrate('20261018120000_account_follow_personal_once');
            await execute(`INSERT INTO "AccountSessionFollow"
                ("accountId", "sessionId", "following", "notificationLevel", "hasPersistentFollow", "includeInVoice", "voiceDeliveredFrontier", "followPolicy", "notifyOnce")
                VALUES ('account', 'same-id', false, 'important', false, true, 'voice-frontier', '{"preset":"quiet"}', '{"kind":"first_needs_you"}');`);
            await migrate(genericMigration);
            const [original] = await query('SELECT * FROM "AccountSessionFollow"');
            expect(original).toMatchObject({ accountId: 'account', sessionId: 'same-id', sourceKey: 'session:same-id',
                notificationLevel: 'important', voiceDeliveredFrontier: 'voice-frontier',
                followPolicy: '{"preset":"quiet"}', notifyOnce: '{"kind":"first_needs_you"}' });
            expect(Boolean(original.following)).toBe(false);
            expect(Boolean(original.hasPersistentFollow)).toBe(false);
            expect(Boolean(original.includeInVoice)).toBe(true);
            await migrate('20261021045500_personal_run_permission_progress');
            await migrate(policyContractionMigration);
            await execute(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceDiscussionId", "deliveredDiscussionSeq")
                VALUES ('discussion-row', 'account', 'discussion:same-id', 'same-id', 7);
                INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceWorkflowRunId", "deliveredWorkflowRunRevision")
                VALUES ('workflow-row', 'account', 'workflow_run:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'same-id', 3);
                INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceExecutionRunSessionId", "sourceExecutionRunId", "deliveredExecutionRunTerminalEventId", "deliveredExecutionRunPermissionKey")
                VALUES ('execution-row', 'account', 'execution_run:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'same-id', 'run', 'terminal-event', 'permission-key');
                INSERT INTO "AccountSessionFollow" ("id", "accountId", "sessionId") VALUES ('legacy-null', 'account', 'legacy-null');`);
            const before = await query('SELECT * FROM "AccountSessionFollow" ORDER BY "id"');
            const indexes = database instanceof DatabaseSync
                ? await query(`SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'AccountSessionFollow' ORDER BY name`)
                : null;
            await migrate(sourceIdentityMigration);
            expect(await query('SELECT * FROM "AccountSessionFollow" ORDER BY "id"')).toEqual(before);
            if (database instanceof DatabaseSync) {
                expect(await query(`SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'AccountSessionFollow' ORDER BY name`)).toEqual(indexes);
                expect(await query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            }
            await expect(execute(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceDiscussionId")
                VALUES ('duplicate', 'account', 'discussion:same-id', 'same-id')`)).rejects.toThrow();
            for (const [id, columns, values] of [
                ['discussion-null', '"sourceDiscussionId"', "'same-id'"],
                ['execution-null', '"sourceExecutionRunSessionId", "sourceExecutionRunId"', "'same-id', 'run'"],
                ['workflow-null', '"sourceWorkflowRunId"', "'same-id'"],
                ['execution-prefix', '"sourceExecutionRunSessionId", "sourceExecutionRunId", "sourceKey"', "'same-id', 'run', 'executionXrun:abc'"],
                ['workflow-prefix', '"sourceWorkflowRunId", "sourceKey"', "'same-id', 'workflowXrun:abc'"],
                ['workflow-case', '"sourceWorkflowRunId", "sourceKey"', "'same-id', 'WORKFLOW_run:abc'"],
                ['mixed', '"sessionId", "sourceDiscussionId", "sourceKey"', "'same-id', 'same-id', 'session:same-id'"],
            ]) {
                await expect(execute(`INSERT INTO "AccountSessionFollow" ("id", "accountId", ${columns})
                    VALUES ('${id}', 'account', ${values})`)).rejects.toThrow(/AccountSessionFollow_source_identity_check/);
            }
            for (const id of ['discussion-row', 'execution-row', 'workflow-row']) {
                await expect(execute(`UPDATE "AccountSessionFollow" SET "sourceKey" = NULL WHERE "id" = '${id}'`))
                    .rejects.toThrow(/AccountSessionFollow_source_identity_check/);
            }
            await expect(execute(`UPDATE "AccountSessionFollow" SET "deliveredDiscussionSeq" = -1 WHERE "id" = 'discussion-row'`))
                .rejects.toThrow(/AccountSessionFollow_source_progress_check/);
            await execute(`DELETE FROM "Discussion" WHERE "id" = 'same-id'; DELETE FROM "AutomationRun" WHERE "id" = 'same-id';`);
            expect(await query(`SELECT "id" FROM "AccountSessionFollow" WHERE "id" IN ('discussion-row', 'workflow-row')`)).toEqual([]);
            expect(await query('SELECT "id" FROM "AccountSessionFollow"')).toHaveLength(3);
            await execute(`DELETE FROM "Session" WHERE "id" = 'same-id'`);
            expect(await query('SELECT "sessionId" FROM "AccountSessionFollow"')).toEqual([{ sessionId: 'legacy-null' }]);
            if (database instanceof DatabaseSync) expect(await query('PRAGMA foreign_key_check')).toEqual([]);
        } finally {
            await database.close();
        }
    });
});
