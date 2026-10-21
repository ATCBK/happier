import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationName = '20261021120000_account_username_intent_and_release';

describe('Account username intent upgrade', () => {
    it.each(['sqlite', 'postgres'] as const)('protects retained names and preserves independent holds on %s', async provider => {
        const sqlite = provider === 'sqlite' ? new DatabaseSync(':memory:') : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const execute = async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); };
        const rows = async (sql: string) => sqlite ? sqlite.prepare(sql).all()
            : (await postgres!.query<Record<string, unknown>>(sql)).rows;
        try {
            // These are the unchanged predecessor Account identity columns; the
            // migration must not normalize retained custom-policy names.
            await execute(`CREATE TABLE "Account" ("id" TEXT PRIMARY KEY, "username" TEXT UNIQUE);
                INSERT INTO "Account" VALUES ('empty', NULL), ('underscore', 'Old_Name'),
                    ('hyphen', 'old-name'), ('reserved', 'admin');`);
            const retained = await rows('SELECT "id", "username" FROM "Account" ORDER BY "id"');
            await execute(await readFile(join(import.meta.dirname, '../../prisma',
                provider === 'sqlite' ? 'sqlite/migrations' : 'migrations', migrationName, 'migration.sql'), 'utf8'));
            expect(await rows('SELECT "id", "username" FROM "Account" ORDER BY "id"')).toEqual(retained);
            const intent = await rows('SELECT "id", "usernameAutoFillEnabled" FROM "Account" ORDER BY "id"');
            expect(intent.map(row => ({ id: row.id, enabled: Boolean(row.usernameAutoFillEnabled) }))).toEqual([
                { id: 'empty', enabled: true }, { id: 'hyphen', enabled: false },
                { id: 'reserved', enabled: false }, { id: 'underscore', enabled: false },
            ]);
            await execute(`INSERT INTO "Account" ("id") VALUES ('new');`);
            expect((await rows(`SELECT "usernameAutoFillEnabled" FROM "Account" WHERE "id" = 'new'`))
                .map(row => Boolean(row.usernameAutoFillEnabled))).toEqual([true]);
            await execute(`INSERT INTO "ReleasedUsername" ("username", "expiresAt")
                VALUES ('Old_Name', '2026-11-20 12:00:00.123');
                DELETE FROM "Account" WHERE "id" = 'underscore';`);
            expect(await rows('SELECT "username" FROM "ReleasedUsername"')).toEqual([{ username: 'Old_Name' }]);
            await expect(execute(`INSERT INTO "ReleasedUsername" ("username", "expiresAt")
                VALUES ('Old_Name', '2026-12-20 12:00:00.123');`)).rejects.toThrow();
        } finally {
            sqlite?.close();
            await postgres?.close();
        }
    });
});
