import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/mysql-client/index.js";
import { runPrismaCli } from "../prismaCli";

const databaseUrl = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;
const serverRoot = join(import.meta.dirname, "../..");
const migrationName = "20261011120000_add_account_name";

describe("Account name MySQL upgrade", () => {
    (databaseUrl ? it : it.skip)("retains profile bytes while backfilling trimmed names beyond the old part width", async () => {
        const databaseName = `account_name_${randomUUID().replaceAll("-", "")}`;
        const isolatedUrl = new URL(databaseUrl!);
        isolatedUrl.pathname = `/${databaseName}`;
        const admin = new PrismaClient({ datasourceUrl: databaseUrl });
        const db = new PrismaClient({ datasourceUrl: isolatedUrl.toString() });
        const stage = await mkdtemp(join(tmpdir(), "happier-account-name-mysql-"));
        const sourceRoot = join(serverRoot, "prisma/mysql");
        const stageMigration = async (name: string) => {
            await mkdir(join(stage, "migrations", name), { recursive: true });
            await copyFile(join(sourceRoot, "migrations", name, "migration.sql"), join(stage, "migrations", name, "migration.sql"));
        };
        const deploy = () => runPrismaCli({
            serverRoot,
            args: ["migrate", "deploy", "--schema", join(stage, "schema.prisma")],
            env: { ...process.env, DATABASE_URL: isolatedUrl.toString() },
            quiet: true,
        });
        let created = false;
        try {
            await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            created = true;
            await copyFile(join(sourceRoot, "schema.prisma"), join(stage, "schema.prisma"));
            await stageMigration("20260202164738_baseline");
            await writeFile(join(stage, "migrations/migration_lock.toml"), 'provider = "mysql"\n');
            await deploy();
            const firstName = "a".repeat(191);
            const lastName = "b".repeat(191);
            await db.$executeRawUnsafe(
                "INSERT INTO `Account` (`id`,`publicKey`,`firstName`,`lastName`,`updatedAt`) VALUES ('long','long',?,?,CURRENT_TIMESTAMP(3)),('trim','trim',?,?,CURRENT_TIMESTAMP(3)),('blank','blank',?,?,CURRENT_TIMESTAMP(3))",
                firstName, lastName, "\tAda\n", "\u00a0Lovelace\u00a0", "\t \n", "\u00a0",
            );
            await stageMigration(migrationName);
            await deploy();
            await deploy();
            expect(await db.$queryRawUnsafe("SELECT `id`,`firstName`,`lastName`,`name` FROM `Account` ORDER BY `id`"))
                .toEqual([
                    { id: "blank", firstName: "\t \n", lastName: "\u00a0", name: null },
                    { id: "long", firstName, lastName, name: `${firstName} ${lastName}` },
                    { id: "trim", firstName: "\tAda\n", lastName: "\u00a0Lovelace\u00a0", name: "Ada Lovelace" },
                ]);
        } finally {
            await db.$disconnect();
            if (created) await admin.$executeRawUnsafe(`DROP DATABASE \`${databaseName}\``);
            await admin.$disconnect();
            await rm(stage, { recursive: true, force: true });
        }
    }, 120_000);
});
