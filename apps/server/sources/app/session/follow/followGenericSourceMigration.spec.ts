import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrations = resolve(import.meta.dirname, '../../../../prisma/sqlite/migrations');
const genericMigration = '20261019150000_account_follow_generic_sources';
const postgresMigrations = resolve(migrations, '../../migrations');

function applyMigration(sqlite: DatabaseSync, name: string) {
    const path = resolve(migrations, name, 'migration.sql');
    if (existsSync(path)) sqlite.exec(readFileSync(path, 'utf8'));
}

describe('generic Follow source storage upgrade', () => {
    it('preserves Session personal rows and their one-shot/Voice custody while admitting distinct generic sources', () => {
        const sqlite = new DatabaseSync(':memory:');
        try {
            sqlite.exec(`PRAGMA foreign_keys = ON;
                CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Session" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Discussion" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY);
                INSERT INTO "Account" VALUES ('account');
                INSERT INTO "Session" VALUES ('same-id');
                INSERT INTO "Discussion" VALUES ('same-id');
                INSERT INTO "AutomationRun" VALUES ('same-id');`);
            applyMigration(sqlite, '20260906120000_add_account_session_follows');
            applyMigration(sqlite, '20261018120000_account_follow_personal_once');
            sqlite.exec(`INSERT INTO "AccountSessionFollow"
                ("accountId", "sessionId", "following", "notificationLevel", "hasPersistentFollow", "includeInVoice", "voiceDeliveredFrontier", "followPolicy", "notifyOnce")
                VALUES ('account', 'same-id', 0, 'important', 0, 1, 'voice-frontier', '{"preset":"quiet"}', '{"kind":"first_needs_you"}');`);
            applyMigration(sqlite, genericMigration);

            const original = sqlite.prepare(`SELECT "accountId", "sessionId", "sourceKey", "following", "notificationLevel",
                "hasPersistentFollow", "includeInVoice", "voiceDeliveredFrontier", "followPolicy", "notifyOnce"
                FROM "AccountSessionFollow" WHERE "sessionId" = 'same-id'`).get();
            expect(original).toEqual({ accountId: 'account', sessionId: 'same-id', sourceKey: 'session:same-id', following: 0,
                notificationLevel: 'important', hasPersistentFollow: 0, includeInVoice: 1, voiceDeliveredFrontier: 'voice-frontier',
                followPolicy: '{"preset":"quiet"}', notifyOnce: '{"kind":"first_needs_you"}' });
            sqlite.exec(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceDiscussionId")
                VALUES ('discussion-row', 'account', 'discussion:same-id', 'same-id');
                INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceWorkflowRunId")
                VALUES ('workflow-row', 'account', 'workflow_run:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'same-id');`);
            expect(sqlite.prepare(`SELECT "sourceKey" FROM "AccountSessionFollow" ORDER BY "sourceKey"`).all()).toHaveLength(3);
            expect(() => sqlite.exec(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceDiscussionId")
                VALUES ('duplicate', 'account', 'discussion:same-id', 'same-id')`)).toThrow();
            expect(() => sqlite.exec(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sessionId", "sourceDiscussionId")
                VALUES ('mixed', 'account', 'session:same-id', 'same-id', 'same-id')`)).toThrow();
            expect(() => sqlite.exec(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceDiscussionId")
                VALUES ('missing-key', 'account', 'same-id')`)).toThrow();
            expect(() => sqlite.exec(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceWorkflowRunId")
                VALUES ('bad-prefix', 'account', 'workflowXrun:abc', 'same-id')`)).toThrow();
            sqlite.exec(`DELETE FROM "Discussion" WHERE "id" = 'same-id'`);
            expect(sqlite.prepare(`SELECT "id" FROM "AccountSessionFollow" WHERE "id" = 'discussion-row'`).get()).toBeUndefined();
            sqlite.exec(`DELETE FROM "AutomationRun" WHERE "id" = 'same-id'`);
            expect(sqlite.prepare(`SELECT "id" FROM "AccountSessionFollow" WHERE "id" = 'workflow-row'`).get()).toBeUndefined();
            expect(sqlite.prepare(`SELECT "sessionId" FROM "AccountSessionFollow"`).all()).toEqual([{ sessionId: 'same-id' }]);
            expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally {
            sqlite.close();
        }
    });

    it('upgrades an existing personal row before admitting generic sources in PostgreSQL', async () => {
        const postgres = new PGlite();
        try {
            await postgres.waitReady;
            await postgres.exec(`CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Session" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Discussion" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY);
                INSERT INTO "Account" ("id") VALUES ('account');
                INSERT INTO "Session" VALUES ('same-id');
                INSERT INTO "Discussion" VALUES ('same-id');
                INSERT INTO "AutomationRun" VALUES ('same-id');`);
            for (const name of ['20260906120000_add_account_session_follows', '20261018120000_account_follow_personal_once']) {
                await postgres.exec(readFileSync(resolve(postgresMigrations, name, 'migration.sql'), 'utf8'));
            }
            await postgres.exec(`INSERT INTO "AccountSessionFollow"
                ("accountId", "sessionId", "following", "notificationLevel", "hasPersistentFollow", "includeInVoice", "voiceDeliveredFrontier", "followPolicy", "notifyOnce")
                VALUES ('account', 'same-id', false, 'important', false, true, 'voice-frontier', '{"preset":"quiet"}', '{"kind":"first_needs_you"}');`);
            const path = resolve(postgresMigrations, genericMigration, 'migration.sql');
            if (existsSync(path)) await postgres.exec(readFileSync(path, 'utf8'));
            expect((await postgres.query(`SELECT "accountId", "sessionId", "sourceKey", "following", "hasPersistentFollow",
                "includeInVoice", "voiceDeliveredFrontier", "followPolicy", "notifyOnce" FROM "AccountSessionFollow" WHERE "sessionId" = 'same-id'`)).rows)
                .toEqual([{ accountId: 'account', sessionId: 'same-id', sourceKey: 'session:same-id', following: false,
                    hasPersistentFollow: false, includeInVoice: true, voiceDeliveredFrontier: 'voice-frontier',
                    followPolicy: '{"preset":"quiet"}', notifyOnce: '{"kind":"first_needs_you"}' }]);
            await postgres.exec(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceDiscussionId")
                VALUES ('discussion-row', 'account', 'discussion:same-id', 'same-id');`);
            await expect(postgres.exec(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceDiscussionId")
                VALUES ('missing-key', 'account', 'same-id')`)).rejects.toThrow();
            await expect(postgres.exec(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceWorkflowRunId")
                VALUES ('bad-prefix', 'account', 'workflowXrun:abc', 'same-id')`)).rejects.toThrow();
            await postgres.exec(`DELETE FROM "Discussion" WHERE "id" = 'same-id'`);
            expect((await postgres.query('SELECT "id" FROM "AccountSessionFollow"')).rows).toHaveLength(1);
        } finally {
            await postgres.close();
        }
    });
});
