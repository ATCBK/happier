import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { FollowPolicyV1Schema, resolveFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

const migrations = resolve(import.meta.dirname, '../../../../prisma/sqlite/migrations');
const managerMigration = '20261018213000_merge_manager_follow_relation';

describe('Session Follow source identity upgrades', () => {
    it('preserves every existing frontier and attachment while admitting a disjoint Discussion source', () => {
        const sqlite = new DatabaseSync(':memory:');
        try {
            // Only referenced resources are fixture boundaries; all Follow DDL and the
            // data transition below run from the actual canonical migration files.
            sqlite.exec(`PRAGMA foreign_keys = ON;
                CREATE TABLE "Session" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Discussion" ("id" TEXT PRIMARY KEY, "messageSeq" INTEGER);
                CREATE TABLE "DiscussionParticipant" ("discussionId" TEXT, "sessionId" TEXT, "removedAt" DATETIME);
                CREATE TABLE "SessionReportsTo" (
                    "sessionId" TEXT, "leadSessionId" TEXT, "attachedAt" DATETIME,
                    "deliveredTranscriptSeq" INTEGER, "deliveredReadyEventSeq" INTEGER,
                    "deliveredAgentStateVersion" INTEGER, "deliveredTurnId" TEXT, "deliveredTurnStatus" TEXT
                );
                INSERT INTO "Session" VALUES ('same-id'), ('destination'), ('other-source');
                INSERT INTO "AutomationRun" VALUES ('same-id');
                INSERT INTO "Discussion" VALUES ('same-id', 11);
                INSERT INTO "DiscussionParticipant" VALUES ('same-id', 'destination', NULL),
                    ('same-id', 'same-id', '2026-10-18 12:01:00'), ('same-id', NULL, NULL);`);
            sqlite.exec(readFileSync(resolve(migrations, '20260905230000_add_session_follow_edges/migration.sql'), 'utf8'));
            sqlite.exec(`INSERT INTO "SessionFollowEdge" VALUES ('same-id', 'destination', 'wake_on_human_change', 7, 8, 9, 'old-turn', 'failed');
                INSERT INTO "SessionReportsTo" VALUES ('same-id', 'destination', '2026-10-18 12:00:00.123', 3, 4, 5, 'manager-turn', 'completed');`);
            sqlite.exec(readFileSync(resolve(migrations, managerMigration, 'migration.sql'), 'utf8'));
            const before = sqlite.prepare('SELECT * FROM "SessionFollowEdge" ORDER BY "relation"').all();
            for (const name of readdirSync(migrations).filter(name => name > managerMigration).sort()) {
                if (name === 'migration_lock.toml') continue;
                const sql = readFileSync(resolve(migrations, name, 'migration.sql'), 'utf8');
                if (/\b(?:ALTER TABLE|CREATE TABLE) "(?:new_)?SessionFollowEdge"/u.test(sql)) sqlite.exec(sql);
            }
            const after = sqlite.prepare('SELECT * FROM "SessionFollowEdge" WHERE "sourceSessionId" IS NOT NULL ORDER BY "relation"').all();
            expect(after.map(({ policyJson, sourceExecutionRunSessionId, sourceExecutionRunId, sourceWorkflowRunId,
                deliveredExecutionRunTerminalEventId, deliveredWorkflowRunRevision, ...row }) => row))
                .toEqual(before.map(({ mode, ...row }) => ({ ...row, sourceKey: 'session:same-id', sourceDiscussionId: null })));
            for (const row of after) {
                const policy = FollowPolicyV1Schema.parse(JSON.parse(String(row.policyJson)));
                expect(policy.preset).toBe(row.relation === 'manager' ? 'important' : 'custom');
                expect(resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'person_wrote' } }).session.wake)
                    .toBe(row.relation === 'follower');
            }
            expect(sqlite.prepare('SELECT "sourceKey", "sourceSessionId", "destinationSessionId", "deliveredTranscriptSeq" FROM "SessionFollowEdge" WHERE "sourceDiscussionId" IS NOT NULL').all())
                .toEqual([{ sourceKey: 'discussion:same-id', sourceSessionId: null, destinationSessionId: 'destination', deliveredTranscriptSeq: 11 }]);
            const discussionPolicy = sqlite.prepare('SELECT "policyJson" FROM "SessionFollowEdge" WHERE "sourceDiscussionId" IS NOT NULL').get();
            expect(JSON.parse(String(discussionPolicy?.policyJson))).toEqual({ preset: 'important' });
            sqlite.exec(`INSERT INTO "SessionFollowEdge" ("sourceKey", "sourceExecutionRunSessionId", "sourceExecutionRunId", "destinationSessionId", "policyJson", "deliveredExecutionRunTerminalEventId")
                VALUES ('execution_run:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'same-id', 'run-id', 'destination', '{"preset":"important"}', 'terminal-id');
                INSERT INTO "SessionFollowEdge" ("sourceKey", "sourceWorkflowRunId", "destinationSessionId", "policyJson", "deliveredWorkflowRunRevision")
                VALUES ('workflow_run:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'same-id', 'destination', '{"preset":"important"}', 7);`);
            expect(sqlite.prepare(`SELECT "sourceSessionId", "sourceDiscussionId", "sourceExecutionRunSessionId", "sourceExecutionRunId", "sourceWorkflowRunId", "deliveredExecutionRunTerminalEventId", "deliveredWorkflowRunRevision"
                FROM "SessionFollowEdge" WHERE "sourceKey" LIKE '%_run:%' ORDER BY "sourceKey"`).all()).toEqual([
                { sourceSessionId: null, sourceDiscussionId: null, sourceExecutionRunSessionId: 'same-id', sourceExecutionRunId: 'run-id',
                    sourceWorkflowRunId: null, deliveredExecutionRunTerminalEventId: 'terminal-id', deliveredWorkflowRunRevision: null },
                { sourceSessionId: null, sourceDiscussionId: null, sourceExecutionRunSessionId: null, sourceExecutionRunId: null,
                    sourceWorkflowRunId: 'same-id', deliveredExecutionRunTerminalEventId: null, deliveredWorkflowRunRevision: 7 },
            ]);
            expect(() => sqlite.exec(`UPDATE "SessionFollowEdge" SET "relation" = 'manager', "managerSourceSessionId" = 'same-id'
                WHERE "sourceExecutionRunId" = 'run-id'`)).toThrow();
            expect(() => sqlite.exec(`UPDATE "SessionFollowEdge" SET "sourceDiscussionId" = 'same-id'
                WHERE "sourceExecutionRunId" = 'run-id'`)).toThrow();
            expect(() => sqlite.exec(`UPDATE "SessionFollowEdge" SET "sourceKey" = 'session:other-source' WHERE "sourceDiscussionId" IS NOT NULL`)).toThrow();
            expect(() => sqlite.exec(`UPDATE "SessionFollowEdge" SET "sourceSessionId" = 'other-source' WHERE "sourceDiscussionId" IS NOT NULL`)).toThrow();
            expect(() => sqlite.exec(`UPDATE "SessionFollowEdge" SET "relation" = 'manager', "managerSourceSessionId" = 'other-source'
                WHERE "sourceDiscussionId" IS NOT NULL`)).toThrow();
            sqlite.exec(`DELETE FROM "Discussion" WHERE "id" = 'same-id'`);
            expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "SessionFollowEdge"').get()).toEqual({ n: 4 });
            sqlite.exec(`DELETE FROM "AutomationRun" WHERE "id" = 'same-id'`);
            expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "SessionFollowEdge"').get()).toEqual({ n: 3 });
            expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            sqlite.exec(`DELETE FROM "Session" WHERE "id" = 'same-id'`);
            expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "SessionFollowEdge"').get()).toEqual({ n: 0 });
        } finally {
            sqlite.close();
        }
    });

    it('preserves the same upgrade and source constraints in PostgreSQL', async () => {
        const postgres = new PGlite();
        const postgresMigrations = resolve(migrations, '../../migrations');
        try {
            await postgres.waitReady;
            await postgres.exec(`CREATE TABLE "Session" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Discussion" ("id" TEXT PRIMARY KEY, "messageSeq" INTEGER);
                CREATE TABLE "DiscussionParticipant" ("discussionId" TEXT, "sessionId" TEXT, "removedAt" TIMESTAMP(3));
                INSERT INTO "Session" VALUES ('same-id'), ('destination'), ('other-source');
                INSERT INTO "AutomationRun" VALUES ('same-id');
                INSERT INTO "Discussion" VALUES ('same-id', 11);
                INSERT INTO "DiscussionParticipant" VALUES ('same-id', 'destination', NULL), ('same-id', 'same-id', CURRENT_TIMESTAMP);`);
            await postgres.exec(readFileSync(resolve(postgresMigrations, '20260905230000_add_session_follow_edges/migration.sql'), 'utf8'));
            await postgres.exec(`CREATE TABLE "SessionReportsTo" (
                "sessionId" TEXT, "leadSessionId" TEXT, "attachedAt" TIMESTAMP(3),
                "deliveredTranscriptSeq" INTEGER, "deliveredReadyEventSeq" INTEGER,
                "deliveredAgentStateVersion" INTEGER, "deliveredTurnId" TEXT, "deliveredTurnStatus" "SessionFollowDeliveredTurnStatus"
            );
            INSERT INTO "SessionFollowEdge" VALUES ('same-id', 'destination', 'wake_on_human_change', 7, 8, 9, 'old-turn', 'failed');
            INSERT INTO "SessionReportsTo" VALUES ('same-id', 'destination', '2026-10-18 12:00:00.123', 3, 4, 5, 'manager-turn', 'completed');`);
            await postgres.exec(readFileSync(resolve(postgresMigrations, managerMigration, 'migration.sql'), 'utf8'));
            const before = await postgres.query<Record<string, unknown>>('SELECT * FROM "SessionFollowEdge" ORDER BY "relation"');
            await postgres.exec(readFileSync(resolve(postgresMigrations, '20261018230000_session_follow_source_identity/migration.sql'), 'utf8'));
            await postgres.exec(readFileSync(resolve(postgresMigrations, '20261018233000_session_follow_policy/migration.sql'), 'utf8'));
            const genericEdgeMigration = resolve(postgresMigrations, '20261019150100_session_follow_run_sources/migration.sql');
            if (existsSync(genericEdgeMigration)) await postgres.exec(readFileSync(genericEdgeMigration, 'utf8'));
            const after = (await postgres.query<Record<string, unknown>>('SELECT * FROM "SessionFollowEdge" WHERE "sourceSessionId" IS NOT NULL ORDER BY "relation"')).rows;
            expect(after.map(({ policyJson, sourceExecutionRunSessionId, sourceExecutionRunId, sourceWorkflowRunId,
                deliveredExecutionRunTerminalEventId, deliveredWorkflowRunRevision, ...row }) => row))
                .toEqual(before.rows.map(({ mode, ...row }) => ({ ...row, sourceKey: 'session:same-id', sourceDiscussionId: null })));
            for (const row of after) {
                const policy = FollowPolicyV1Schema.parse(JSON.parse(String(row.policyJson)));
                expect(policy.preset).toBe(row.relation === 'manager' ? 'important' : 'custom');
                expect(resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'person_wrote' } }).session.wake)
                    .toBe(row.relation === 'follower');
            }
            expect((await postgres.query('SELECT "sourceKey", "sourceSessionId", "destinationSessionId", "deliveredTranscriptSeq" FROM "SessionFollowEdge" WHERE "sourceDiscussionId" IS NOT NULL')).rows)
                .toEqual([{ sourceKey: 'discussion:same-id', sourceSessionId: null, destinationSessionId: 'destination', deliveredTranscriptSeq: 11 }]);
            const discussionPolicy = (await postgres.query<{ policyJson: string }>('SELECT "policyJson" FROM "SessionFollowEdge" WHERE "sourceDiscussionId" IS NOT NULL')).rows[0];
            expect(JSON.parse(String(discussionPolicy?.policyJson))).toEqual({ preset: 'important' });
            await expect(postgres.exec(`UPDATE "SessionFollowEdge" SET "sourceKey" = 'session:other-source' WHERE "sourceDiscussionId" IS NOT NULL`))
                .rejects.toThrow();
            await expect(postgres.exec(`UPDATE "SessionFollowEdge" SET "sourceSessionId" = 'other-source' WHERE "sourceDiscussionId" IS NOT NULL`))
                .rejects.toThrow();
            await expect(postgres.exec(`UPDATE "SessionFollowEdge" SET "relation" = 'manager', "managerSourceSessionId" = 'other-source' WHERE "sourceDiscussionId" IS NOT NULL`))
                .rejects.toThrow();
            await postgres.exec(`DELETE FROM "Discussion" WHERE "id" = 'same-id'`);
            expect((await postgres.query('SELECT COUNT(*)::int AS n FROM "SessionFollowEdge"')).rows).toEqual([{ n: 2 }]);
            await postgres.exec(`DELETE FROM "Session" WHERE "id" = 'same-id'`);
            expect((await postgres.query('SELECT COUNT(*)::int AS n FROM "SessionFollowEdge"')).rows).toEqual([{ n: 0 }]);
        } finally {
            await postgres.close();
        }
    });
});
