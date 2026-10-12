import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { claimDirectorySourceFullReconcile } from "./directorySourceService";
import { runClaimedDirectoryProjectionReconcile } from "./directoryReconciler";

describe("directory projection reconciler", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-directory-reconcile-",
            initAuth: false,
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: "1" },
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["workos_sso"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    async function createClaimedSource(suffix: string) {
        const team = await db.team.create({ data: { name: `Reconcile ${suffix}` } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "WorkOS",
                enabled: true,
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1 },
                settings: { v: 1 },
            },
        });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "workos_directory",
                state: "needs_attention",
                displayName: "WorkOS",
                externalSourceKey: `workos-reconcile:${suffix}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: suffix },
                teamIdentityConnectionId: connection.id,
                lastAttemptAt: new Date("2026-09-05T09:00:00.000Z"),
                lastSuccessAt: new Date("2026-09-05T08:00:00.000Z"),
                lastFullReconcileAt: new Date("2026-09-05T08:00:00.000Z"),
                manualSyncRequestedAt: new Date("2026-09-05T10:00:00.000Z"),
            },
        });
        const claim = await claimDirectorySourceFullReconcile({
            sourceId: source.id,
            reconcileRunId: `${suffix}-run`,
            now: new Date("2026-09-05T10:01:00.000Z"),
        });
        if (!claim.ok) throw new Error(`failed to claim source: ${claim.code}`);
        return claim.source;
    }

    it("commits bounded source pages and makes the complete no-native projection active", async () => {
        const source = await createClaimedSource("success");

        const result = await runClaimedDirectoryProjectionReconcile({
            source,
            completedAt: new Date("2026-09-05T10:05:00.000Z"),
            catchUp: async () => ({ ok: true }),
            scan: async ({ writePeoplePage, writeGroupsPage, writeGroupMembersPage }) => {
                if (!await writePeoplePage([{ externalUserId: "user-1", displayName: "Alice", active: true }])) {
                    return { ok: false, code: "stale_run" };
                }
                if (!await writeGroupsPage([{ externalGroupId: "group-1", displayName: "Engineering" }])) {
                    return { ok: false, code: "stale_run" };
                }
                if (!await writeGroupMembersPage([{ externalGroupId: "group-1", externalUserId: "user-1" }])) {
                    return { ok: false, code: "stale_run" };
                }
                return { ok: true };
            },
        });

        expect(result).toEqual({ status: "completed" });
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } })).resolves.toMatchObject({
            state: "active",
            activeReconcileRunId: null,
            manualSyncRequestedAt: null,
            lastSuccessAt: new Date("2026-09-05T10:05:00.000Z"),
            lastFullReconcileAt: new Date("2026-09-05T10:05:00.000Z"),
        });
        await expect(db.teamDirectoryGroupMember.findUniqueOrThrow({
            where: {
                directorySourceId_externalGroupId_externalUserId: {
                    directorySourceId: source.id,
                    externalGroupId: "group-1",
                    externalUserId: "user-1",
                },
            },
        })).resolves.toMatchObject({ lastSeenReconcileRunId: source.reconcileRunId });
    });

    it("preserves the last complete success and native authority after a partial scan failure", async () => {
        const source = await createClaimedSource("failure");

        const result = await runClaimedDirectoryProjectionReconcile({
            source,
            scan: async ({ writePeoplePage }) => {
                await writePeoplePage([{ externalUserId: "partial-user", active: true }]);
                return { ok: false, code: "directory_snapshot_incomplete" };
            },
        });

        expect(result).toEqual({ status: "failed", code: "directory_snapshot_incomplete" });
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } })).resolves.toMatchObject({
            state: "needs_attention",
            activeReconcileRunId: null,
            lastErrorCode: "directory_snapshot_incomplete",
            lastSuccessAt: new Date("2026-09-05T08:00:00.000Z"),
            lastFullReconcileAt: new Date("2026-09-05T08:00:00.000Z"),
        });
        await expect(db.teamProvisionedIdentity.findUniqueOrThrow({
            where: {
                directorySourceId_externalUserId: {
                    directorySourceId: source.id,
                    externalUserId: "partial-user",
                },
            },
        })).resolves.toMatchObject({ state: "active", lastSeenReconcileRunId: source.reconcileRunId });
    });

    it("stops the current run before its next projection write when Home policy disables the provider", async () => {
        const source = await createClaimedSource("policy-disabled-during-fetch");
        try {
            const result = await runClaimedDirectoryProjectionReconcile({
                source,
                scan: async ({ writePeoplePage }) => {
                    await db.homeGovernancePolicy.upsert({
                        where: { id: "home" },
                        create: {
                            id: "home",
                            teamProviderPolicy: {
                                v: 1,
                                allowedTeamProviderKinds: ["oidc", "github_app_identity"],
                                teamJitAllowed: false,
                                approvedGitHubEnterpriseOrigins: [],
                            },
                        },
                        update: {
                            teamProviderPolicy: {
                                v: 1,
                                allowedTeamProviderKinds: ["oidc", "github_app_identity"],
                                teamJitAllowed: false,
                                approvedGitHubEnterpriseOrigins: [],
                            },
                        },
                    });
                    return await writePeoplePage([{ externalUserId: "blocked-user", active: true }])
                        ? { ok: true }
                        : { ok: false, code: "stale_run" };
                },
            });

            expect(result).toEqual({ status: "stale" });
            await expect(db.teamProvisionedIdentity.findUnique({
                where: {
                    directorySourceId_externalUserId: {
                        directorySourceId: source.id,
                        externalUserId: "blocked-user",
                    },
                },
            })).resolves.toBeNull();
            await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } }))
                .resolves.toMatchObject({ state: "initializing", activeReconcileRunId: source.reconcileRunId });
        } finally {
            await db.homeGovernancePolicy.update({
                where: { id: "home" },
                data: {
                    teamProviderPolicy: {
                        v: 1,
                        allowedTeamProviderKinds: ["workos_sso"],
                        teamJitAllowed: false,
                        approvedGitHubEnterpriseOrigins: [],
                    },
                },
            });
        }
    });

    it("stops the current run before its next projection write when the Teams feature is disabled", async () => {
        const source = await createClaimedSource("feature-disabled-during-fetch");
        const previousEnv = process.env;
        try {
            const result = await runClaimedDirectoryProjectionReconcile({
                source,
                scan: async ({ writePeoplePage }) => {
                    process.env = {
                        ...(previousEnv ?? {}),
                        HAPPIER_FEATURE_TEAMS__ENABLED: "false",
                    };
                    return await writePeoplePage([{ externalUserId: "blocked-feature-user", active: true }])
                        ? { ok: true }
                        : { ok: false, code: "stale_run" };
                },
            });

            expect(result).toEqual({ status: "stale" });
            await expect(db.teamProvisionedIdentity.findUnique({
                where: {
                    directorySourceId_externalUserId: {
                        directorySourceId: source.id,
                        externalUserId: "blocked-feature-user",
                    },
                },
            })).resolves.toBeNull();
        } finally {
            process.env = previousEnv;
        }
    });

    it("atomically removes a source when WorkOS reports its exact directory deleted", async () => {
        const source = await createClaimedSource("deleted");

        await expect(runClaimedDirectoryProjectionReconcile({
            source,
            scan: async () => ({ ok: true }),
            catchUp: async () => ({ ok: true, sourceDeleted: true }),
        })).resolves.toEqual({ status: "completed" });

        await expect(db.teamDirectorySource.findUnique({ where: { id: source.id } })).resolves.toBeNull();
    });

    it("removes an initializing source when the full scan proves the exact WorkOS directory is deleted", async () => {
        const source = await createClaimedSource("deleted-during-scan");

        await expect(runClaimedDirectoryProjectionReconcile({
            source,
            scan: async () => ({ ok: true, sourceDeleted: true }),
        })).resolves.toEqual({ status: "completed" });

        await expect(db.teamDirectorySource.findUnique({ where: { id: source.id } })).resolves.toBeNull();
    });
});
