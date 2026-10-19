import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";

import { db } from "@/storage/db";
import { withSqliteReadSnapshot } from '@/storage/prisma';
import { ConnectedServiceQuotaSnapshotV1Schema } from "@happier-dev/protocol";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import {
    ConnectedServiceUsageSourceBindingError,
} from "../providerAccountUsage/types";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../providerAccountUsageTestkit";
import {
    mutateQualifiedConnectedServiceCredential,
} from "./credentialRepository";
import {
    createQualifiedConnectedAccountGroup,
    createQualifiedConnectedAccountGroupMember,
} from "./groupRepository";
import { resolveLegacyQualifiedConnectedAccountService } from "./identity";
import { projectProviderAccountUsageSnapshotToLegacyQuota } from "./legacyUsageTranslation";
import {
    listQualifiedUsageSourcesForRecord,
    readQualifiedConnectedAccountUsageRecord,
    readQualifiedConnectedAccountQuota,
    readQualifiedProviderAccountUsageHistory,
    requestQualifiedConnectedAccountQuotaRefresh,
    unlinkQualifiedConnectedAccountQuota,
    writeQualifiedProviderAccountUsageRecord,
    writeLegacyConnectedServiceQuotaCompatibilityRecord,
} from "./usageRepository";

const service = Object.freeze({
    pluginId: "example.connected-accounts",
    localId: "identity-guard",
});
const providerAccountId = "provider-identity-guard";

describe("qualified Connected Account usage stored identity", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-qualified-usage-identity-",
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await db.serviceAccountToken.deleteMany();
        await db.account.deleteMany();
    });

    async function createCredential(accountId: string, encrypted = false, credentialService: Parameters<typeof mutateQualifiedConnectedServiceCredential>[0]["ref"]["service"] = service) {
        const ref = {
            service: credentialService,
            accountId: "qualified-account",
        };
        const credential =
            await mutateQualifiedConnectedServiceCredential({
                accountId,
                ref,
                expectedCredentialRevision: null,
                authenticationModeId: "api-key",
                content: encrypted ? { t: "encrypted", c: "opaque-e2ee-credential" } : {
                    t: "plain",
                    v: { token: "credential" },
                },
                metadata: {
                    scopes: [],
                    providerIdentity: {
                        accountId: providerAccountId,
                    },
                },
            });
        if (credential.status !== "written") {
            throw new Error("Expected qualified credential create");
        }
        return { credential, ref };
    }

    function buildUsageWrite(
        accountId: string,
        params: Readonly<{
            credentialRevision: string;
            source: Parameters<
                typeof writeQualifiedProviderAccountUsageRecord
            >[0]["source"];
            fetchedAt: number;
            planLabel: string;
        }>,
    ) {
        const recordKey = createProviderAccountUsageRecordKey({
            accountSubjectId: providerAccountId,
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: params.fetchedAt,
            recordKey,
            planLabel: params.planLabel,
        });
        return {
            accountId,
            source: params.source,
            expectedCredentialRevision:
                params.credentialRevision,
            expectedConfigurationRevision: null,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1" as const,
            status: "ok" as const,
            snapshot,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        };
    }

    it.each(['page', 'witness'] as const)('releases the history transaction before validating captured %s payloads', async kind => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const { credential, ref } = await createCredential(account.id);
        const write = buildUsageWrite(account.id, { credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: 'account' }, fetchedAt: Date.now() - 1000, planLabel: 'history' });
        await writeQualifiedProviderAccountUsageRecord(write);
        const witness = await db.providerAccountUsageHistory.findFirstOrThrow({ where: { accountId: account.id, recordId: write.recordId },
            select: { id: true, observedAt: true } });
        let leased = false;
        let parsed = 0;
        let restore = () => {};
        // Observe the actual read connection: SQLite snapshots intentionally
        // bypass Prisma's write-pool $transaction (which begins IMMEDIATE).
        await withSqliteReadSnapshot(async reader => {
            const originalExecute = reader.$executeRawUnsafe;
            const originalFind = reader.providerAccountUsageRecord.findUnique;
            const execute = originalExecute.bind(reader);
            const find = originalFind.bind(reader.providerAccountUsageRecord);
            reader.$executeRawUnsafe = (async (query: string, ...values: unknown[]) => {
                const result = await execute(query, ...values);
                if (query === 'BEGIN DEFERRED;') leased = true;
                if (query === 'ROLLBACK;') leased = false;
                return result;
            }) as typeof reader.$executeRawUnsafe;
            // This boundary observer returns real awaited rows; Prisma's
            // generated delegate additionally advertises PrismaPromise methods.
            reader.providerAccountUsageRecord.findUnique = (async (args: Parameters<typeof find>[0]) => {
                const row = await find(args);
                if (row && 'history' in row && Array.isArray(row.history)) {
                    for (const entry of row.history) {
                        const payload: unknown = entry.payload;
                        Object.defineProperty(entry, 'payload', { get() {
                            parsed++;
                            expect(leased, 'history parsing must not hold a transaction connection').toBe(false);
                            return payload;
                        } });
                    }
                }
                return row;
            }) as unknown as typeof reader.providerAccountUsageRecord.findUnique;
            restore = () => {
                reader.$executeRawUnsafe = originalExecute;
                reader.providerAccountUsageRecord.findUnique = originalFind;
            };
        });
        try {
            const result = await readQualifiedProviderAccountUsageHistory({ accountId: account.id, recordId: write.recordId,
                ...(kind === 'page' ? { history: { range: { startAtMs: write.fetchedAt, endAtMs: write.fetchedAt + 1 }, pageSize: 100 } }
                    : { witness: { id: witness.id, observedAtMs: witness.observedAt.getTime() } }) });
            expect(result).toMatchObject({ status: 'resolved', entries: [{ record: { snapshot: write.snapshot } }], nextCursor: null });
            expect(parsed).toBeGreaterThan(0);
        } finally { restore(); }
    });

    it("preserves opaque recovery details through the qualified quota reader", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" }, select: { id: true } });
        const { credential, ref } = await createCredential(account.id, true);
        const write = buildUsageWrite(account.id, {
            credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: "account" }, fetchedAt: Date.now() - 1000,
            planLabel: "encrypted account",
        });
        const { snapshot: _snapshot, ...baseWrite } = write;
        const recoveryCreditDetails = { ciphertext: "opaque-recovery-details" };
        await writeQualifiedProviderAccountUsageRecord({
            ...baseWrite, payloadMode: "sealed_account_scoped_v1",
            sealedPayload: { format: "account_scoped_v1", ciphertext: "opaque-base", recoveryCreditDetails },
        });
        expect(await readQualifiedConnectedAccountQuota({ accountId: account.id, ref }))
            .toMatchObject({ content: { t: "encrypted", c: "opaque-base", recoveryCreditDetails } });
    });

    it("preserves legacy quota recovery details through intrinsic storage and quota projections", async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const serviceId = "anthropic" as const;
        const { ref } = await createCredential(account.id, false, resolveLegacyQualifiedConnectedAccountService(serviceId));
        const fetchedAt = Date.now() - 1000;
        const recoveryCreditDetails = { reset_one: { remainingCount: 2, appliesToProviderLimitIds: ["weekly"] } };
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1, serviceId, profileId: ref.accountId, fetchedAt, staleAfterMs: 60_000,
            planLabel: "legacy plan", accountLabel: null, source: "provider_api", confidence: "exact",
            recoveryCreditDetails, meters: [],
        });
        await writeLegacyConnectedServiceQuotaCompatibilityRecord({
            accountId: account.id, serviceId, profileId: ref.accountId,
            payloadMode: "plain_json_v1", status: "ok", fetchedAt,
            staleAfterMs: snapshot.staleAfterMs, snapshot,
        });
        const stored = await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref });
        expect(stored?.snapshot).toMatchObject({ recoveryCreditDetails });
        expect(await readQualifiedConnectedAccountQuota({ accountId: account.id, ref }))
            .toMatchObject({ content: { t: "plain", v: { recoveryCreditDetails } } });
        expect(projectProviderAccountUsageSnapshotToLegacyQuota({ serviceId, profileId: ref.accountId, snapshot: stored?.snapshot }))
            .toMatchObject({ recoveryCreditDetails });
    });

    it('accepts refresh for a producer-initialized account before its first quota observation', async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: 'plain' },
            select: { id: true },
        });
        const { credential, ref } = await createCredential(account.id);
        const write = buildUsageWrite(account.id, {
            credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: 'account' },
            fetchedAt: 0,
            planLabel: 'not observed',
        });
        const snapshot = { ...write.snapshot, state: 'not_loaded' as const, planLabel: null, meters: [] };
        await writeQualifiedProviderAccountUsageRecord({ ...write, status: 'unavailable', snapshot });

        await expect(requestQualifiedConnectedAccountQuotaRefresh({ accountId: account.id, ref }))
            .resolves.toBe('written');
        const stored = await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref });
        expect(stored).toMatchObject({ snapshot: { state: 'not_loaded', meters: [] } });
        expect(stored?.refreshRequestedAt).toBeGreaterThan(0);
        await expect(listQualifiedUsageSourcesForRecord({ accountId: account.id, recordId: write.recordId }))
            .resolves.toEqual([{ ref, bindingKind: 'account' }]);
    });

    it("rejects a group binding whose stored structured tuple disagrees with its retained digests", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const groupRef = {
            service,
            groupId: "qualified-group",
        };
        const createdGroup =
            await createQualifiedConnectedAccountGroup({
                accountId: account.id,
                service,
                group: { groupId: groupRef.groupId },
            });
        if (createdGroup.status !== "written") {
            throw new Error("Expected qualified group create");
        }
        const withMember =
            await createQualifiedConnectedAccountGroupMember({
                accountId: account.id,
                mutation: {
                    group: groupRef,
                    connectedAccountId: ref.accountId,
                    expectedGeneration: createdGroup.group.generation,
                    expectedRuntimeStateRevision:
                        createdGroup.group.runtimeStateRevision,
                },
            });
        if (withMember.status !== "written") {
            throw new Error("Expected qualified group member create");
        }
        const storedGroup =
            await db.connectedServiceAuthGroup.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    groupId: groupRef.groupId,
                },
                select: {
                    id: true,
                    qualifiedServiceDigest: true,
                    qualifiedGroupDigest: true,
                },
            });
        await db.connectedServiceAuthGroup.update({
            where: { id: storedGroup.id },
            data: {
                servicePluginId: "corrupt.group.identity",
            },
        });

        const write = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: {
                ref,
                bindingKind: "group_member",
                groupId: groupRef.groupId,
                groupGeneration: withMember.group.generation,
            },
            fetchedAt: Date.now(),
            planLabel: "must-not-persist",
        });
        await expect(
            writeQualifiedProviderAccountUsageRecord(write),
        ).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(db.providerAccountUsageRecord.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        await expect(db.connectedServiceUsageSource.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        await expect(
            db.connectedServiceAuthGroup.findUniqueOrThrow({
                where: { id: storedGroup.id },
                select: {
                    servicePluginId: true,
                    qualifiedServiceDigest: true,
                    qualifiedGroupDigest: true,
                },
            }),
        ).resolves.toEqual({
            servicePluginId: "corrupt.group.identity",
            qualifiedServiceDigest:
                storedGroup.qualifiedServiceDigest,
            qualifiedGroupDigest:
                storedGroup.qualifiedGroupDigest,
        });
    });

    it("rejects projection from a usage row whose structured tuple disagrees with its retained digests", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const write = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "original",
        });
        await writeQualifiedProviderAccountUsageRecord(write);
        const source =
            await db.connectedServiceUsageSource.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    providerAccountUsageRecordId: write.recordId,
                },
                select: {
                    id: true,
                    qualifiedServiceDigest: true,
                    qualifiedIdentityDigest: true,
                },
            });
        await db.connectedServiceUsageSource.update({
            where: { id: source.id },
            data: {
                serviceLocalId: "corrupt-usage-identity",
            },
        });

        await expect(listQualifiedUsageSourcesForRecord({
            accountId: account.id,
            recordId: write.recordId,
        })).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(
            db.connectedServiceUsageSource.findUniqueOrThrow({
                where: { id: source.id },
                select: {
                    serviceLocalId: true,
                    qualifiedServiceDigest: true,
                    qualifiedIdentityDigest: true,
                },
            }),
        ).resolves.toEqual({
            serviceLocalId: "corrupt-usage-identity",
            qualifiedServiceDigest:
                source.qualifiedServiceDigest,
            qualifiedIdentityDigest:
                source.qualifiedIdentityDigest,
        });
    });

    it("finds a valid account source after more than fifty earlier unproven sources", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } = await createCredential(account.id);
        const validWrite = buildUsageWrite(account.id, {
            credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "valid-after-unproven-sources",
        });
        await writeQualifiedProviderAccountUsageRecord(validWrite);

        const storedCredential = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                servicePluginId: true,
                serviceLocalId: true,
                qualifiedServiceDigest: true,
                connectedAccountId: true,
                qualifiedIdentityDigest: true,
            },
        });
        const laterUpdatedAt = new Date(Date.now() + 60_000);
        for (let index = 0; index < 50; index += 1) {
            const recordId = `unproven-record-${index}`;
            await db.providerAccountUsageRecord.create({
                data: {
                    accountId: account.id,
                    providerId: `unproven-provider-${index}`,
                    recordId,
                    accountSubjectId: `unproven-subject-${index}`,
                    subjectKind: "workspace",
                    quotaScope: "workspace",
                    quotaScopeId: `unproven-scope-${index}`,
                    quotaScopeIdKey: `unproven-scope-${index}`,
                    recordKeyJson: {},
                    payloadMode: "plain_json_v1",
                    status: "ok",
                    updatedAt: laterUpdatedAt,
                },
            });
            await db.connectedServiceUsageSource.create({
                data: {
                    accountId: account.id,
                    servicePluginId: storedCredential.servicePluginId,
                    serviceLocalId: storedCredential.serviceLocalId,
                    qualifiedServiceDigest:
                        storedCredential.qualifiedServiceDigest,
                    connectedAccountId:
                        storedCredential.connectedAccountId,
                    qualifiedIdentityDigest:
                        storedCredential.qualifiedIdentityDigest,
                    credentialId: storedCredential.id,
                    sourceKey: `unproven-source-${index}`,
                    providerAccountUsageRecordId: recordId,
                    bindingKind: "account",
                    updatedAt: laterUpdatedAt,
                },
            });
        }

        await expect(readQualifiedConnectedAccountUsageRecord({
            accountId: account.id,
            ref,
        })).resolves.toMatchObject({ recordId: validWrite.recordId });
    });

    it("rolls back a usage write instead of repairing a corrupt source tuple through its digest lookup", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const firstWrite = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "original",
        });
        await writeQualifiedProviderAccountUsageRecord(
            firstWrite,
        );
        const source =
            await db.connectedServiceUsageSource.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    providerAccountUsageRecordId:
                        firstWrite.recordId,
                },
                select: { id: true },
            });
        await db.connectedServiceUsageSource.update({
            where: { id: source.id },
            data: {
                connectedAccountId:
                    "corrupt-usage-account",
            },
        });
        const replacementWrite = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: firstWrite.fetchedAt + 1,
            planLabel: "must-not-replace",
        });

        await expect(
            writeQualifiedProviderAccountUsageRecord(
                replacementWrite,
            ),
        ).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(
            db.providerAccountUsageRecord.findUniqueOrThrow({
                where: {
                    accountId_recordId: {
                        accountId: account.id,
                        recordId: firstWrite.recordId,
                    },
                },
                select: { snapshot: true },
            }),
        ).resolves.toMatchObject({
            snapshot: {
                planLabel: "original",
            },
        });
        await expect(
            db.connectedServiceUsageSource.findUniqueOrThrow({
                where: { id: source.id },
                select: {
                    connectedAccountId: true,
                    providerAccountUsageRecordId: true,
                },
            }),
        ).resolves.toEqual({
            connectedAccountId:
                "corrupt-usage-account",
            providerAccountUsageRecordId:
                firstWrite.recordId,
        });
    });

    it("refuses digest-addressed unlink when a matched source has a corrupt structured tuple", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const write = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "must-remain-linked",
        });
        await writeQualifiedProviderAccountUsageRecord(write);
        const source =
            await db.connectedServiceUsageSource.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    providerAccountUsageRecordId: write.recordId,
                },
                select: { id: true },
            });
        await db.connectedServiceUsageSource.update({
            where: { id: source.id },
            data: {
                servicePluginId:
                    "corrupt.unlink.identity",
            },
        });

        await expect(
            unlinkQualifiedConnectedAccountQuota({
                accountId: account.id,
                ref,
            }),
        ).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(
            db.connectedServiceUsageSource.count({
                where: { id: source.id },
            }),
        ).resolves.toBe(1);
    });
});
