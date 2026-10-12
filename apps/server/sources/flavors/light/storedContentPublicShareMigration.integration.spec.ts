import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySqliteMigrations, type SqliteMigrationExecutor } from "./sqliteMigrations";

const migrationName = "20261002200000_stored_content_public_shares";

describe("stored-content public-share retained SQLite upgrade", () => {
    it("runs the real migration owner with foreign keys enabled and preserves legacy shares and nonempty access logs exactly", async () => {
        const temporary = await mkdtemp(join(tmpdir(), "happier-public-share-upgrade-"));
        const database = new DatabaseSync(join(temporary, "retained.sqlite"));
        const migrationsDir = join(temporary, "migrations");
        const canonicalDir = join(process.cwd(), "prisma", "sqlite", "migrations");
        const executor: SqliteMigrationExecutor = {
            exec: sql => { database.exec(sql); },
            queryRows: (sql, values = []) => database.prepare(sql).all(...values),
            run: (sql, values = []) => { database.prepare(sql).run(...values); },
            queryTableNames: () => new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name))),
            queryAppliedMigrations: () => database.prepare("SELECT migration_name, checksum FROM _prisma_migrations WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL").all().map(row => ({ name: String(row.migration_name), checksum: String(row.checksum) })),
            insertAppliedMigration: ({ name, checksum }) => { database.prepare("INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)").run(crypto.randomUUID(), checksum, name); },
        };
        try {
            for (const entry of await readdir(canonicalDir, { withFileTypes: true })) {
                if (entry.isDirectory() && entry.name < migrationName) await cp(join(canonicalDir, entry.name), join(migrationsDir, entry.name), { recursive: true });
            }
            database.exec("PRAGMA foreign_keys=ON");
            await applySqliteMigrations({ executor, migrationsDir });
            database.exec(`
                INSERT INTO Account (id, createdAt, updatedAt) VALUES ('retained-owner', 1, 2);
                INSERT INTO Session (id, accountId, tag, metadata, createdAt, updatedAt) VALUES ('retained-session', 'retained-owner', 'retained-tag', 'retained-ciphertext', 3, 4);
                INSERT INTO PublicSessionShare (id, sessionId, createdByUserId, tokenHash, encryptedDataKey, expiresAt, maxUses, useCount, isConsentRequired, createdAt, updatedAt)
                VALUES ('retained-share', 'retained-session', 'retained-owner', X'012345', X'6789AB', 9000, 7, 3, 1, 5, 6);
                INSERT INTO PublicShareAccessLog (id, publicShareId, userId, ipAddress, userAgent, accessedAt)
                VALUES ('retained-log', 'retained-share', NULL, '198.51.100.3', 'retained-browser', 7);
            `);
            const shareBefore = database.prepare("SELECT * FROM PublicSessionShare").all();
            const logsBefore = database.prepare("SELECT * FROM PublicShareAccessLog").all();
            await cp(join(canonicalDir, migrationName), join(migrationsDir, migrationName), { recursive: true });
            expect((await applySqliteMigrations({ executor, migrationsDir })).applied).toEqual([migrationName]);
            const sharesAfter = database.prepare("SELECT * FROM PublicSessionShare").all();
            expect(sharesAfter.map(({ artifactId, keyDerivation, ...row }) => row)).toEqual(shareBefore);
            expect(sharesAfter[0]).toMatchObject({ artifactId: null, keyDerivation: "legacy_token_v1" });
            expect(database.prepare("SELECT * FROM PublicShareAccessLog").all()).toEqual(logsBefore);
            expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
            expect(database.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
            expect((await applySqliteMigrations({ executor, migrationsDir })).applied).toEqual([]);
            // Upgrade in chronological order, including subsequent schema additions.
            for (const entry of await readdir(canonicalDir, { withFileTypes: true })) {
                if (entry.isDirectory() && entry.name > migrationName) await cp(join(canonicalDir, entry.name), join(migrationsDir, entry.name), { recursive: true });
            }
            await applySqliteMigrations({ executor, migrationsDir });
            expect(database.prepare("SELECT * FROM PublicSessionShare").all()).toEqual([expect.objectContaining(sharesAfter[0])]);
            expect(database.prepare("SELECT * FROM PublicShareAccessLog").all()).toEqual(logsBefore);
            expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
            expect((await applySqliteMigrations({ executor, migrationsDir })).applied).toEqual([]);
            database.prepare("DELETE FROM PublicSessionShare WHERE id=?").run("retained-share");
            expect(database.prepare("SELECT * FROM PublicShareAccessLog").all()).toEqual([]);
        } finally {
            database.close();
            await rm(temporary, { recursive: true, force: true });
        }
    }, 180_000);
});
