import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { mentionMigrationId as migrationId, mentionMigrationFixtures as fixtures, migratedMentionParts as newParts } from './discussionMentionMigration.testkit';

const serverRoot = join(import.meta.dirname, '../..');

describe('Plain Discussion Account mention forward migration', () => {
    it.each(['sqlite', 'postgres'] as const)('preserves order, identity and opaque/typed neighbors on %s', async provider => {
        const sqlite = provider === 'sqlite' ? new DatabaseSync(':memory:') : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const exec = async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); };
        const rows = async () => {
            const result = sqlite ? sqlite.prepare('SELECT * FROM "DiscussionMessage" ORDER BY "id"').all()
                : (await postgres!.query<Record<string, unknown>>('SELECT * FROM "DiscussionMessage" ORDER BY "id"')).rows;
            return result.map(row => ({ ...row,
                content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content }));
        };
        try {
            await exec(`CREATE TABLE "DiscussionMessage" ("id" TEXT PRIMARY KEY, "localId" TEXT NOT NULL,
                "seq" INTEGER NOT NULL, "authorAccountId" TEXT, "requestEqualityEvidenceV1" TEXT NOT NULL, "content" JSONB NOT NULL);`);
            for (const [index, fixture] of fixtures.entries()) await exec(`INSERT INTO "DiscussionMessage"
                VALUES ('${fixture.id}', 'retry-${fixture.id}', ${index + 1}, 'author', 'retained-equality',
                    '${JSON.stringify(fixture.content).replaceAll("'", "''")}');`);
            const before = await rows();
            const sql = await readFile(join(serverRoot, provider === 'sqlite' ? 'prisma/sqlite/migrations' : 'prisma/migrations',
                migrationId, 'migration.sql'), 'utf8');
            await exec(sql);
            const after = await rows();
            expect(after).toEqual(before.map(row => row.id === 'legacy'
                ? { ...row, content: { t: 'plain', v: { v: 1, parts: newParts } } } : row));
            await exec(sql);
            expect(await rows()).toEqual(after);
        } finally { sqlite?.close(); await postgres?.close(); }
    });
});
