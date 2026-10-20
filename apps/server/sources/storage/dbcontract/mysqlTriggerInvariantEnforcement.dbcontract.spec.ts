import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql } from "@/storage/db";
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';

const provider = String(process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "")
    .trim()
    .toLowerCase();

function uniqueId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
}

describe.skipIf(provider !== "mysql")("MySQL trigger invariant enforcement", () => {
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL for the MySQL trigger invariant contract.");
        }
        await initDbMysql();
        await db.$connect();
        dbConnected = true;
    });

    afterAll(async () => {
        if (!dbConnected) return;
        await db.$disconnect();
    });

    it("rejects Session Follow self-edge inserts and updates independently of sql_mode", async () => {
        await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET SESSION sql_mode = ''");
            try {
                const account = await tx.account.create({
                    data: { publicKey: uniqueId("mysql-follow-trigger-account") },
                    select: { id: true },
                });
                const emptyIdSession = await tx.session.create({
                    data: {
                        id: "",
                        accountId: account.id,
                        tag: uniqueId("mysql-follow-trigger-empty"),
                        metadata: "{}",
                    },
                    select: { id: true },
                });
                expect(emptyIdSession.id).toBe("");
                const source = await tx.session.create({
                    data: {
                        accountId: account.id,
                        tag: uniqueId("mysql-follow-trigger-source"),
                        metadata: "{}",
                    },
                    select: { id: true },
                });
                const destination = await tx.session.create({
                    data: {
                        accountId: account.id,
                        tag: uniqueId("mysql-follow-trigger-destination"),
                        metadata: "{}",
                    },
                    select: { id: true },
                });

                await tx.sessionFollowEdge.create({
                    data: {
                        sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }),
                        sourceSessionId: source.id,
                        destinationSessionId: destination.id,
                        policyJson: JSON.stringify({ preset: 'quiet' }),
                    },
                });
                await expect(tx.sessionFollowEdge.create({
                    data: {
                        sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: destination.id }),
                        sourceSessionId: destination.id,
                        destinationSessionId: destination.id,
                        policyJson: JSON.stringify({ preset: 'quiet' }),
                    },
                })).rejects.toThrow("SessionFollowEdge source and destination must differ");
                await expect(tx.sessionFollowEdge.update({
                    where: {
                        destinationSessionId_sourceSessionId_relation: {
                            destinationSessionId: destination.id,
                            sourceSessionId: source.id,
                            relation: 'follower',
                        },
                    },
                    data: { destinationSessionId: source.id },
                })).rejects.toThrow("SessionFollowEdge source and destination must differ");
                await expect(tx.sessionFollowEdge.findMany({
                    select: { sourceSessionId: true, destinationSessionId: true },
                })).resolves.toEqual([{
                    sourceSessionId: source.id,
                    destinationSessionId: destination.id,
                }]);
            } finally {
                await tx.$executeRawUnsafe("SET SESSION sql_mode = @@GLOBAL.sql_mode");
            }
        });
    });

    it('enforces exact polymorphic Follow identity on insert and update without truncating full resource ids', async () => {
        await db.$transaction(async tx => {
            await tx.$executeRawUnsafe("SET SESSION sql_mode = ''");
            try {
                const account = await tx.account.create({ data: { publicKey: uniqueId('follow-source-account') } });
                const source = await tx.session.create({ data: { accountId: account.id, tag: uniqueId('source'), metadata: '{}' } });
                const destination = await tx.session.create({ data: { accountId: account.id, tag: uniqueId('destination'), metadata: '{}' } });
                const discussion = await tx.discussion.create({ data: {
                    id: uniqueId('discussion').padEnd(191, 'd'), ownerAccountId: account.id,
                    encryptionMode: 'plain', dataEncryptionKey: new Uint8Array(), creationLocalId: uniqueId('create'),
                    creationEqualityEvidenceV1: {}, titleContent: {}, lastMessageAt: new Date(),
                } });
                await expect(tx.sessionFollowEdge.create({ data: { sourceKey: 'discussion:wrong',
                    sourceDiscussionId: discussion.id, destinationSessionId: destination.id,
                    policyJson: JSON.stringify({ preset: 'important' }) } })).rejects.toThrow('source identity mismatch');
                const sourceKey = sourceKeyForSessionFollowSourceV1({ kind: 'discussion', discussionId: discussion.id });
                await tx.sessionFollowEdge.create({ data: { sourceKey, sourceDiscussionId: discussion.id,
                    destinationSessionId: destination.id, deliveredTranscriptSeq: 11,
                    policyJson: JSON.stringify({ preset: 'important' }) } });
                const where = { destinationSessionId_sourceDiscussionId_relation: {
                    destinationSessionId: destination.id, sourceDiscussionId: discussion.id, relation: 'follower',
                } };
                expect(await tx.sessionFollowEdge.findUniqueOrThrow({ where, select: { sourceKey: true, deliveredTranscriptSeq: true } }))
                    .toEqual({ sourceKey, deliveredTranscriptSeq: 11 });
                await expect(tx.sessionFollowEdge.update({ where, data: { sourceKey: sourceKey.toUpperCase() } }))
                    .rejects.toThrow('source identity mismatch');
                await expect(tx.sessionFollowEdge.update({ where, data: { sourceSessionId: source.id } }))
                    .rejects.toThrow('source identity mismatch');
                await expect(tx.sessionFollowEdge.update({ where, data: { relation: 'manager', managerSourceSessionId: source.id } }))
                    .rejects.toThrow('manager relation identity mismatch');
                await tx.discussion.delete({ where: { id: discussion.id } });
                expect(await tx.sessionFollowEdge.findUnique({ where })).toBeNull();
            } finally {
                await tx.$executeRawUnsafe('SET SESSION sql_mode = @@GLOBAL.sql_mode');
            }
        });
    });

    it("rejects invalid provisioned-membership inserts and updates independently of sql_mode", async () => {
        await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET SESSION sql_mode = ''");
            try {
                const suffix = randomUUID();
                const accountId = `mysql-identity-trigger-account-${suffix}`;
                const teamId = `mysql-identity-trigger-team-${suffix}`;
                const membershipId = `mysql-identity-trigger-membership-${suffix}`;
                const providerId = `mysql-identity-trigger-provider-${suffix}`;
                const connectionId = `mysql-identity-trigger-connection-${suffix}`;
                const sourceId = `mysql-identity-trigger-source-${suffix}`;
                await tx.$executeRawUnsafe(
                    "INSERT INTO `Account` (`id`,`publicKey`,`updatedAt`) VALUES (?,?,CURRENT_TIMESTAMP(3))",
                    accountId,
                    uniqueId("mysql-identity-trigger-key"),
                );
                await tx.$executeRawUnsafe(
                    "INSERT INTO `Team` (`id`,`name`,`updatedAt`) VALUES (?, 'Trigger Team', CURRENT_TIMESTAMP(3))",
                    teamId,
                );
                await tx.$executeRawUnsafe(
                    "INSERT INTO `TeamMembership` (`id`,`teamId`,`accountId`,`role`) VALUES (?,?,?,'owner')",
                    membershipId,
                    teamId,
                    accountId,
                );
                await tx.$executeRawUnsafe(
                    "INSERT INTO `IdentityProviderInstance` (`id`,`ownerTeamId`,`kind`,`displayName`,`config`,`updatedAt`) VALUES (?,?,'workos_sso','WorkOS','{}',CURRENT_TIMESTAMP(3))",
                    providerId,
                    teamId,
                );
                await tx.$executeRawUnsafe(
                    "INSERT INTO `TeamIdentityConnection` (`id`,`teamId`,`providerInstanceId`,`externalReference`,`settings`,`updatedAt`) VALUES (?,?,?,'{}','{}',CURRENT_TIMESTAMP(3))",
                    connectionId,
                    teamId,
                    providerId,
                );
                await tx.$executeRawUnsafe(
                    "INSERT INTO `TeamDirectorySource` (`id`,`teamId`,`kind`,`displayName`,`externalSourceKey`,`bindingConfig`,`teamIdentityConnectionId`,`updatedAt`) VALUES (?,?, 'workos_directory','Directory',?,'{}',?,CURRENT_TIMESTAMP(3)),('',?,'workos_directory','Empty sentinel',?,'{}',?,CURRENT_TIMESTAMP(3))",
                    sourceId,
                    teamId,
                    uniqueId("mysql-identity-trigger-source-key"),
                    connectionId,
                    teamId,
                    uniqueId("mysql-identity-trigger-empty-key"),
                    connectionId,
                );

                const linkedId = `mysql-identity-trigger-linked-${suffix}`;
                await tx.$executeRawUnsafe(
                    "INSERT INTO `TeamProvisionedIdentity` (`id`,`directorySourceId`,`teamId`,`externalUserId`,`state`,`teamMembershipId`,`teamMembershipTeamId`,`updatedAt`) VALUES (?,?,?,?,'active',?,?,CURRENT_TIMESTAMP(3))",
                    linkedId,
                    sourceId,
                    teamId,
                    uniqueId("mysql-identity-trigger-valid-user"),
                    membershipId,
                    teamId,
                );
                await expect(tx.$executeRawUnsafe(
                    "INSERT INTO `TeamProvisionedIdentity` (`id`,`directorySourceId`,`teamId`,`externalUserId`,`state`,`teamMembershipId`,`teamMembershipTeamId`,`updatedAt`) VALUES (?,?,?,?,'active',?,NULL,CURRENT_TIMESTAMP(3))",
                    uniqueId("mysql-identity-trigger-invalid"),
                    sourceId,
                    teamId,
                    uniqueId("mysql-identity-trigger-invalid-user"),
                    membershipId,
                )).rejects.toThrow("TeamProvisionedIdentity membership must belong to the same Team");
                await expect(tx.$executeRawUnsafe(
                    "UPDATE `TeamProvisionedIdentity` SET `teamMembershipTeamId`=NULL WHERE `id`=?",
                    linkedId,
                )).rejects.toThrow("TeamProvisionedIdentity membership must belong to the same Team");
                await expect(tx.teamProvisionedIdentity.findUniqueOrThrow({
                    where: { id: linkedId },
                    select: {
                        directorySourceId: true,
                        teamMembershipId: true,
                        teamMembershipTeamId: true,
                    },
                })).resolves.toEqual({
                    directorySourceId: sourceId,
                    teamMembershipId: membershipId,
                    teamMembershipTeamId: teamId,
                });
            } finally {
                await tx.$executeRawUnsafe("SET SESSION sql_mode = @@GLOBAL.sql_mode");
            }
        });
    });

    it("rejects invalid Workflow Run origin inserts and updates independently of sql_mode", async () => {
        await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET SESSION sql_mode = ''");
            try {
                const account = await tx.account.create({
                    data: { publicKey: uniqueId("mysql-workflow-trigger-account") },
                    select: { id: true },
                });
                const runId = uniqueId("mysql-workflow-trigger-valid");
                const insertDirectRun = async (id: string, causeKind: "manual" | null) =>
                    await tx.$executeRawUnsafe(
                        "INSERT INTO `AutomationRun` (`id`,`originKind`,`automationId`,`accountId`,`causeKind`,`workflowAcceptedSnapshotEnvelope`,`workflowCustodyState`,`scheduledAt`,`dueAt`,`updatedAt`) VALUES (?,'direct',NULL,?,?, '{}','pending',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))",
                        id,
                        account.id,
                        causeKind,
                    );

                await insertDirectRun(runId, null);
                await expect(insertDirectRun("", "manual"))
                    .rejects.toThrow("AutomationRun origin shape is invalid");
                await expect(tx.$executeRawUnsafe(
                    "UPDATE `AutomationRun` SET `causeKind`='manual' WHERE `id`=?",
                    runId,
                )).rejects.toThrow("AutomationRun origin shape is invalid");
                await expect(tx.automationRun.findUniqueOrThrow({
                    where: { id: runId },
                    select: { id: true, originKind: true, automationId: true, causeKind: true },
                })).resolves.toEqual({
                    id: runId,
                    originKind: "direct",
                    automationId: null,
                    causeKind: null,
                });
            } finally {
                await tx.$executeRawUnsafe("SET SESSION sql_mode = @@GLOBAL.sql_mode");
            }
        });
    });
});
