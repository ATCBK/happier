import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { readFileSync } from 'node:fs';
import tweetnacl from 'tweetnacl';
import { PLUGIN_MANIFEST as CHANNELS_MANIFEST, collectionMigrations as channelsMigrations } from '@happier-dev/plugins-channels/manifest';
import {
    accountSettingsParse,
    FeaturesResponseSchema,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1,
    measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1,
    normalizePluginAccountCollectionContractV1,
    PluginCollectionCandidatePreparationStageRequestV1Schema,
    type PluginAccountCollectionContributionV1,
    type PluginDataCollectionsCapabilities,
    PluginManifestV2Schema,
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
    encodePluginCollectionLogicalValueV1,
    decodePluginCollectionLogicalRowV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

import { createAccountPluginDataStorageHost } from './accountPluginDataStorage';

const pluginId = 'example.collection-migration';
const collectionId = 'tasks';
const credentials = {
    token: 'candidate-preparation-token',
    encryption: null,
} satisfies StoredCredentials;

const sourceContribution = {
    id: collectionId,
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 256 },
            title: { type: 'string', maxLength: 256 },
        },
        required: ['id', 'title'],
        additionalProperties: false,
    },
    rowIdField: 'id',
    serverReadable: ['id', 'title'],
    indexes: [],
    uiQueries: [],
    relations: [],
    identityFields: [],
    migrations: [],
} satisfies PluginAccountCollectionContributionV1;

const targetContribution = {
    id: collectionId,
    schemaVersion: 2,
    readableSchemaVersions: [1],
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 256 },
            title: { type: 'string', maxLength: 256 },
            status: { type: 'string', enum: ['open', 'closed'] },
        },
        required: ['id', 'title', 'status'],
        additionalProperties: false,
    },
    rowIdField: 'id',
    serverReadable: ['id', 'title', 'status'],
    indexes: [],
    uiQueries: [],
    relations: [],
    identityFields: [],
    migrations: [{
        id: 'upgrade-v1-to-v2',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
    }],
} satisfies PluginAccountCollectionContributionV1;

const sourceContract = normalizePluginAccountCollectionContractV1({
    pluginId,
    contribution: sourceContribution,
});
const targetContract = normalizePluginAccountCollectionContractV1({
    pluginId,
    contribution: targetContribution,
});
const binding = Object.freeze({
    source: Object.freeze({
        pluginId,
        collectionId,
        schemaVersion: sourceContract.schemaVersion,
        contractDigest: sourceContract.contractDigest,
    }),
    target: Object.freeze({
        pluginId,
        collectionId,
        schemaVersion: targetContract.schemaVersion,
        contractDigest: targetContract.contractDigest,
    }),
    candidate: Object.freeze({
        releaseVersion: '2.0.0',
        artifactDigest: `sha256:${'c'.repeat(64)}`,
    }),
});

const currentEncryption = async () => Object.freeze({
    mode: 'plain' as const,
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const },
});

function sourceRow(rowId: string, revision: number, title: string, alreadyStaged: boolean) {
    return {
        rowId,
        revision,
        content: { t: 'plain' as const, v: {} },
        projection: { id: rowId, title },
        alreadyStaged,
    };
}

function collectionFeatures(
    limits: PluginDataCollectionsCapabilities,
): CliServerFeaturesSnapshot {
    return {
        status: 'ready',
        features: FeaturesResponseSchema.parse({
            features: {},
            capabilities: { pluginDataCollections: limits },
        }),
    };
}

function createCandidateHost(
    post: (url: string, body: string) => Promise<Readonly<{
        status: number;
        data: unknown;
    }>>,
    options: Readonly<{
        resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
    }> = {},
) {
    return createAccountPluginDataStorageHost({
        contracts: [targetContract],
        readCredentials: async () => credentials,
        isCurrentAccount: () => true,
        resolveAccountScopeKey: () => 'candidate-preparation-account',
        resolveBaseUrl: () => 'https://data.example.test',
        resolveAccountEncryptionCurrentness: currentEncryption,
        http: {
            get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
            post,
        },
        randomBytes: (length) => new Uint8Array(length).fill(7),
        resolveServerFeaturesSnapshot: options.resolveServerFeaturesSnapshot,
    });
}

function createCandidate(params: Readonly<{
    post: (url: string, body: string) => Promise<Readonly<{ status: number; data: unknown }>>;
    migrate: (value: Readonly<Record<string, JsonValue>>, context: Readonly<{ currentRevision: number }>) => Readonly<Record<string, JsonValue>> | Promise<Readonly<Record<string, JsonValue>>>;
    signal?: AbortSignal;
    resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
}>) {
    const host = createCandidateHost(params.post, {
        resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot,
    });
    return host.createCollectionMigrationCandidate({
        binding,
        sourceContract,
        targetContract,
        declarations: [targetContribution],
        runtime: {
            [collectionId]: [{
                id: 'upgrade-v1-to-v2',
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
                migrate: params.migrate,
            }],
        },
        signal: params.signal ?? new AbortController().signal,
        isOccurrenceCurrent: () => true,
    });
}

describe.each([7, 8])('Channels V%s to current through Account Data candidate preparation', version => {
    const retained = JSON.parse(readFileSync(new URL(`../../../../../../packages/plugins/channels/src/testkit/fixtures/channelStateV${version}.json`, import.meta.url), 'utf8'));
    const targetManifest = PluginManifestV2Schema.parse(CHANNELS_MANIFEST);
    const sourceManifest = PluginManifestV2Schema.parse({ ...CHANNELS_MANIFEST, contributes: {
        ...CHANNELS_MANIFEST.contributes, accountCollections: [retained.collection],
    } });
    const sourceDeclaration = sourceManifest.contributes.accountCollections![0]!;
    const targetDeclaration = targetManifest.contributes.accountCollections!.find(item => item.id === 'channel-state')!;
    const source = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels', contribution: sourceDeclaration });
    const target = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels', contribution: targetDeclaration });
    const sourceValidator = compilePluginJsonSchema(sourceDeclaration.schema);
    const targetValidator = compilePluginJsonSchema(targetDeclaration.schema);
    const machineKey = new Uint8Array(32).fill(7);
    const encryptedCredentials = { token: 'channels-candidate-encrypted', encryption: {
        type: 'dataKey' as const, machineKey, publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
    } } satisfies StoredCredentials;

    it.each(['plain', 'e2ee'] as const)('preserves physical revision and retained custody in %s', async mode => {
        const selectedCredentials = mode === 'plain' ? credentials : encryptedCredentials;
        const material = mode === 'plain' ? null : { type: 'dataKey' as const, machineKey };
        const snapshot = material === null ? null : createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee', material, dataKeyPublicKey: encryptedCredentials.encryption.publicKey,
        });
        const vector = retained.retainedEndpointVectors;
        const logical = version === 8 ? retained.connection : { ...retained.connection, payload: { ...retained.connection.payload,
            authorityEpoch: vector.acceptedCurrentAuthorityEpoch, transport: vector.transport,
            replayContinuity: 'none',
            pendingOldTransportStop: vector.pendingOldTransportStop,
        } };
        let currentLogical = logical;
        const staged: JsonValue[] = [];
        const host = createAccountPluginDataStorageHost({
            contracts: [target], readCredentials: async () => selectedCredentials,
            isCurrentAccount: () => true, resolveAccountScopeKey: () => `channels-preparation-${mode}`,
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: async () => mode === 'plain' ? currentEncryption() : {
                mode: 'e2ee' as const, version: 1, signingKeyFingerprint: null,
                contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot!.contentPublicKeyFingerprint),
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' as const },
            },
            randomBytes: length => new Uint8Array(length).fill(3),
            http: {
                get: async () => ({ status: 200, data: { mode, updatedAt: 1 } }),
                post: async (url, body) => {
                    if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                        const rows = [currentLogical, ...(version === 7 ? [retained.eventObligation] : []), retained.checkpoint].map(value => {
                            const encoded = encodePluginCollectionLogicalValueV1({ contract: source,
                                isValidLogicalValue: candidate => isValidPluginJsonSchemaValue(sourceValidator, candidate),
                                value, encryptionMode: mode, material, randomBytes: length => new Uint8Array(length).fill(4),
                            });
                            if (encoded.status !== 'encoded') throw new Error(`Pinned source fixture failed encoding: ${encoded.reason}`);
                            return { rowId: encoded.rowId, revision: 12, content: encoded.content, projection: encoded.projection, alreadyStaged: false };
                        });
                        return { status: 200, data: { rows } };
                    }
                    const request = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(JSON.parse(body));
                    for (const item of request.items) {
                        const decoded = decodePluginCollectionLogicalRowV1({ contract: target,
                            parseStoredLogicalValue: value => isValidPluginJsonSchemaValue(targetValidator, value) ? value : null,
                            row: { rowId: item.source.rowId, revision: 12, ...item.target }, encryptionMode: mode, material,
                        });
                        if (decoded.status !== 'decoded') throw new Error(`Staged target failed decoding: ${decoded.reason}`);
                        staged.push(decoded.value);
                        expect(item.target.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
                    }
                    return { status: 200, data: { results: request.items.map(() => ({ status: 'staged' })) } };
                },
            },
        });
        const candidate = host.createCollectionMigrationCandidate({
            binding: { source: { pluginId: 'happier.channels', collectionId: source.collectionId,
                schemaVersion: source.schemaVersion, contractDigest: source.contractDigest },
                target: { pluginId: 'happier.channels', collectionId: target.collectionId,
                    schemaVersion: target.schemaVersion, contractDigest: target.contractDigest },
                candidate: { releaseVersion: '0.0.0', artifactDigest: `sha256:${'c'.repeat(64)}` } },
            sourceContract: source, targetContract: target, declarations: targetManifest.contributes.accountCollections!, runtime: channelsMigrations,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        });
        await expect(candidate.prepare()).resolves.toBeUndefined();
        if (version === 8) {
            expect(staged).toEqual([{ ...logical, payload: { ...logical.payload, configurationRevision: 12 } }, retained.checkpoint]);
            return;
        }
        const { kind: _transportKind, ...endpoint } = vector.transport;
        expect(staged).toEqual([{ ...logical, payload: { ...logical.payload,
            configurationRevision: 12,
            transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
            pendingOldTransportStop: { kind: 'endpointRetarget', ...endpoint,
                targetMaterialization: logical.payload.transportOrigin.materializationRef,
                transferAuthorityEpoch: vector.acceptedCurrentAuthorityEpoch },
        } }, { ...retained.eventObligation, payload: { ...retained.eventObligation.payload, target: {
            ...retained.eventObligation.payload.target, executionOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
        } } }, retained.checkpoint]);
        currentLogical = { ...logical, payload: { ...logical.payload, pendingOldTransportStop: {
            ...logical.payload.pendingOldTransportStop, predecessorCheckpointedPollInvocation: {
                ...logical.payload.pendingOldTransportStop.predecessorCheckpointedPollInvocation,
                transportOrigin: { ...logical.payload.pendingOldTransportStop.transportOrigin,
                    materializationRef: { ...logical.payload.pendingOldTransportStop.transportOrigin.materializationRef, materializationId: 'mismatched-custody' } },
            },
        } } };
        await expect(candidate.prepare()).rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
        expect(staged).toHaveLength(3);
    });
});

describe('Account Data Collection candidate preparation', () => {
    it('rejects invalid source revisions before migration callbacks or staging', async () => {
        let migrationRan = false;
        let staged = false;
        const candidate = createCandidate({
            post: async url => {
                if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                    return { status: 200, data: { rows: [sourceRow('task-invalid-revision', 0, 'Retained', false)] } };
                }
                staged = true;
                throw new Error('Invalid source revision cannot stage');
            },
            migrate: value => { migrationRan = true; return { ...value, status: 'open' }; },
        });
        await expect(candidate.prepare()).rejects.toMatchObject({ code: 'plugin_collection_protocol_invalid' });
        expect({ migrationRan, staged }).toEqual({ migrationRan: false, staged: false });
    });

    it('supplies the physical retained row revision to the pure migration callback', async () => {
        const staged: unknown[] = [];
        const candidate = createCandidate({
            post: async (url, body) => {
                if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                    return { status: 200, data: { rows: [sourceRow('task-revision', 14, 'Retained', false)] } };
                }
                const request = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(JSON.parse(body));
                staged.push(...request.items);
                return { status: 200, data: { results: [{ status: 'staged' }] } };
            },
            migrate: (value, context) => ({ ...value, status: context?.currentRevision === 14 ? 'open' : 'closed' }),
        });
        await expect(candidate.prepare()).resolves.toBeUndefined();
        expect(staged).toMatchObject([{ source: { revision: 14 }, target: { projection: { status: 'open' } } }]);
    });

    it('returns the existing typed invalid-value failure when a declared migration rejects retained data', async () => {
        let staged = false;
        const candidate = createCandidate({
            post: async (url) => {
                if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                    return { status: 200, data: { rows: [sourceRow('task-rejected', 4, 'Retained', false)] } };
                }
                staged = true;
                throw new Error('Rejected source data must not be staged');
            },
            migrate: () => { throw new Error('Source authority mismatch'); },
        });
        await expect(candidate.prepare()).rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
        expect(staged).toBe(false);
    });
    it('retires an exact persisted candidate binding without requiring its target callback or generation', async () => {
        const post = vi.fn(async (url: string, body: string) => {
            expect(url).toBe(`https://data.example.test${PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1}`);
            expect(JSON.parse(body)).toEqual({ binding });
            return { status: 200, data: { status: 'retired' } };
        });
        const host = createCandidateHost(post);

        await expect(host.retireCollectionMigrationCandidate({
            binding,
            signal: new AbortController().signal,
            isCurrent: () => true,
        })).resolves.toBeUndefined();

        expect(post).toHaveBeenCalledOnce();
    });

    it('does not stage a candidate bound to retired Account A after A→B→A', async () => {
        const credentialsA = { token: 'candidate-preparation-account-a', encryption: null } satisfies StoredCredentials;
        const credentialsB = { token: 'candidate-preparation-account-b', encryption: null } satisfies StoredCredentials;
        const scopeA = resolveAccountSettingsScopeKey(credentialsA);
        const scopeB = resolveAccountSettingsScopeKey(credentialsB);
        const post = vi.fn(async () => {
            throw new Error('A retired candidate must not reach Account Data');
        });

        resetActiveAccountSettingsSnapshotForTests();
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });
            const host = createAccountPluginDataStorageHost({
                contracts: [targetContract],
                readCredentials: async () => credentialsA,
                resolveBaseUrl: () => 'https://data.example.test',
                resolveAccountEncryptionCurrentness: currentEncryption,
                http: {
                    get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
                    post,
                },
                randomBytes: (length) => new Uint8Array(length).fill(7),
            });
            const candidate = host.createCollectionMigrationCandidate({
                binding,
                sourceContract,
                targetContract,
                declarations: [targetContribution],
                runtime: {
                    [collectionId]: [{
                        id: 'upgrade-v1-to-v2',
                        fromSchemaVersion: 1,
                        toSchemaVersion: 2,
                        migrate: (value) => ({ ...value, status: 'open' }),
                    }],
                },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            });

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: scopeB,
            });
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 2,
                loadedAtMs: 3,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });

            await expect(candidate.prepare()).rejects.toMatchObject({
                code: 'plugin_account_storage_unavailable',
            } satisfies Partial<PluginError>);
            expect(post).not.toHaveBeenCalled();
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('uses the one target-bound host operation, skips exact staged revisions, and batches only target material for a source page', async () => {
        const migrate = vi.fn((value: Readonly<Record<string, JsonValue>>) => ({
            ...value,
            status: 'open',
        }));
        const post = vi.fn(async (url: string, body: string) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                expect(JSON.parse(body)).toEqual({ binding, limit: 50 });
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-already-staged', 3, 'Already staged', true),
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: { results: [{ status: 'staged' }, { status: 'staged' }] },
                };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({ post, migrate });

        await expect(candidate.prepare()).resolves.toBeUndefined();

        expect(migrate).toHaveBeenCalledTimes(2);
        expect(migrate).toHaveBeenNthCalledWith(1, { id: 'task-current', title: 'Prepare me' }, { currentRevision: 4 });
        expect(migrate).toHaveBeenNthCalledWith(2, { id: 'task-next', title: 'Prepare this too' }, { currentRevision: 5 });
        const stageCall = post.mock.calls.find(([url]) => (
            String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)
        ));
        expect(JSON.parse(stageCall?.[1] ?? 'null')).toEqual({
            binding,
            items: [
                {
                    source: { rowId: 'task-current', revision: 4 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
                    },
                },
                {
                    source: { rowId: 'task-next', revision: 5 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
                    },
                },
            ],
        });
    });

    it('splits one source page at an advertised lower candidate-stage row cap', async () => {
        const maxBatchBytes = measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(
            PluginCollectionCandidatePreparationStageRequestV1Schema.parse({
                binding,
                items: [
                    {
                        source: { rowId: 'task-current', revision: 4 },
                        target: {
                            content: { t: 'plain' as const, v: {} },
                            projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
                        },
                    },
                    {
                        source: { rowId: 'task-next', revision: 5 },
                        target: {
                            content: { t: 'plain' as const, v: {} },
                            projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
                        },
                    },
                ],
            }),
        );
        const post = vi.fn(async (url: string, body: string) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                const request = JSON.parse(body) as { items: readonly unknown[] };
                return {
                    status: 200,
                    data: { results: request.items.map(() => ({ status: 'staged' })) },
                };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({
            post,
            migrate: (value) => ({ ...value, status: 'open' }),
            resolveServerFeaturesSnapshot: () => collectionFeatures({
                maxRowEncodedBytes: maxBatchBytes,
                maxBatchBytes,
                maxBatchRows: 1,
                maxAccountRows: 100,
                maxAccountBytes: maxBatchBytes,
            }),
        });

        await expect(candidate.prepare()).resolves.toBeUndefined();

        const stageBodies = post.mock.calls
            .filter(([url]) => String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1))
            .map(([, body]) => JSON.parse(body));
        expect(stageBodies).toEqual([
            {
                binding,
                items: [{
                    source: { rowId: 'task-current', revision: 4 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
                    },
                }],
            },
            {
                binding,
                items: [{
                    source: { rowId: 'task-next', revision: 5 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
                    },
                }],
            },
        ]);
    });

    it('splits one source page at the advertised canonical candidate-stage byte cap', async () => {
        const firstItem = {
            source: { rowId: 'task-current', revision: 4 },
            target: {
                content: { t: 'plain' as const, v: {} },
                projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
            },
        };
        const secondItem = {
            source: { rowId: 'task-next', revision: 5 },
            target: {
                content: { t: 'plain' as const, v: {} },
                projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
            },
        };
        const maxBatchBytes = Math.max(
            measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(
                PluginCollectionCandidatePreparationStageRequestV1Schema.parse({ binding, items: [firstItem] }),
            ),
            measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(
                PluginCollectionCandidatePreparationStageRequestV1Schema.parse({ binding, items: [secondItem] }),
            ),
        );
        const post = vi.fn(async (url: string, body: string) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                const request = JSON.parse(body) as { items: readonly unknown[] };
                return {
                    status: 200,
                    data: { results: request.items.map(() => ({ status: 'staged' })) },
                };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({
            post,
            migrate: (value) => ({ ...value, status: 'open' }),
            resolveServerFeaturesSnapshot: () => collectionFeatures({
                maxRowEncodedBytes: maxBatchBytes,
                maxBatchBytes,
                maxBatchRows: 100,
                maxAccountRows: 100,
                maxAccountBytes: maxBatchBytes,
            }),
        });

        await expect(candidate.prepare()).resolves.toBeUndefined();

        const stageBodies = post.mock.calls
            .filter(([url]) => String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1))
            .map(([, body]) => JSON.parse(body));
        expect(stageBodies).toHaveLength(2);
        expect(stageBodies.map((body) => (body as { items: readonly unknown[] }).items)).toEqual([
            [firstItem],
            [secondItem],
        ]);
    });

    it('does not replay a callback inside one sourceChanged attempt but may invoke it again on a later preparation attempt', async () => {
        const migrate = vi.fn((value: Readonly<Record<string, JsonValue>>) => ({
            ...value,
            status: 'open',
        }));
        const sourcePage = vi.fn();
        const stage = vi.fn();
        const post = vi.fn(async (url: string, _body: string) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                sourcePage();
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                stage();
                return stage.mock.calls.length === 1
                    ? { status: 200, data: { results: [{ status: 'sourceChanged' }] } }
                    : { status: 200, data: { results: [{ status: 'staged' }] } };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({
            post,
            migrate,
            resolveServerFeaturesSnapshot: () => collectionFeatures({
                maxRowEncodedBytes: 2048,
                maxBatchBytes: 4096,
                maxBatchRows: 1,
                maxAccountRows: 100,
                maxAccountBytes: 4096,
            }),
        });

        await expect(candidate.prepare()).rejects.toMatchObject({
            code: 'collection_candidate_preparation_source_changed',
        } satisfies Partial<PluginError>);

        expect(migrate).toHaveBeenCalledTimes(2);
        expect(sourcePage).toHaveBeenCalledOnce();
        expect(stage).toHaveBeenCalledOnce();

        await expect(candidate.prepare()).resolves.toBeUndefined();

        // A callback has at-least-once semantics until its exact output is
        // accepted. The host does not retain a second receipt or suppress a
        // fresh candidate-preparation attempt after the failed stage CAS.
        expect(migrate).toHaveBeenCalledTimes(4);
        expect(sourcePage).toHaveBeenCalledTimes(2);
        expect(stage).toHaveBeenCalledTimes(3);
    });

    it('drains an aborted callback before retiring its exact binding and never stages its output', async () => {
        const pendingMigration = {
            release: null as ((value: Readonly<Record<string, JsonValue>>) => void) | null,
        };
        const migrate = vi.fn((value: Readonly<Record<string, JsonValue>>) => new Promise<Readonly<Record<string, JsonValue>>>((resolve) => {
            pendingMigration.release = () => resolve({ ...value, status: 'open' });
        }));
        const post = vi.fn(async (url: string, _body: string) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: { rows: [sourceRow('task-current', 4, 'Prepare me', false)] },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)) {
                return { status: 200, data: { status: 'retired' } };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                throw new Error('Cancelled candidate preparation must not stage callback output');
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({ post, migrate });
        const preparing = candidate.prepare();

        await vi.waitFor(() => expect(migrate).toHaveBeenCalledOnce());
        const retiring = candidate.retire();
        expect(post.mock.calls.some(([url]) => (
            String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)
        ))).toBe(false);
        if (!pendingMigration.release) throw new Error('Expected the migration callback to be pending');
        pendingMigration.release({ id: 'task-current', title: 'Prepare me' });

        await expect(preparing).rejects.toMatchObject({
            code: 'plugin_collection_cancelled',
        } satisfies Partial<PluginError>);
        await expect(retiring).resolves.toBeUndefined();
        expect(JSON.parse(post.mock.calls.find(([url]) => (
            String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)
        ))?.[1] ?? 'null')).toEqual({ binding });
    });

    it('uses the Account-A retirement authority captured before staging after active credentials switch to Account B', async () => {
        const accountA = {
            token: 'candidate-preparation-account-a',
            encryption: null,
        } satisfies StoredCredentials;
        const accountB = {
            token: 'candidate-preparation-account-b',
            encryption: null,
        } satisfies StoredCredentials;
        let activeCredentials: StoredCredentials = accountA;
        const encodedBodies: string[] = [];
        const adapterBodies: unknown[] = [];
        const post = vi.fn(async (
            url: string,
            body: string,
            config: Readonly<Record<string, unknown>>,
        ) => {
            adapterBodies.push(body);
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: { rows: [sourceRow('task-current', 4, 'Prepare me', false)] },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                return { status: 200, data: { results: [{ status: 'staged' }] } };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)) {
                expect(config).toMatchObject({
                    headers: { Authorization: 'Bearer candidate-preparation-account-a' },
                });
                return { status: 200, data: { status: 'retired' } };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const transport = axios.create({
            adapter: async config => {
                if (typeof config.data !== 'string') throw new Error('Expected preencoded Account Data bytes');
                const response = await post(config.url ?? '', config.data, { ...config });
                return { ...response, config, headers: {}, statusText: '' };
            },
        });
        const host = createAccountPluginDataStorageHost({
            contracts: [targetContract],
            readCredentials: async () => activeCredentials,
            isCurrentAccount: (candidate) => candidate === activeCredentials,
            resolveAccountScopeKey: () => 'candidate-preparation-account',
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: currentEncryption,
            http: {
                get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
                post: async (url, body, config) => {
                    encodedBodies.push(body);
                    return await transport.post(url, body, config);
                },
            },
            randomBytes: (length) => new Uint8Array(length).fill(7),
        });
        const candidate = host.createCollectionMigrationCandidate({
            binding,
            sourceContract,
            targetContract,
            declarations: [targetContribution],
            runtime: {
                [collectionId]: [{
                    id: 'upgrade-v1-to-v2',
                    fromSchemaVersion: 1,
                    toSchemaVersion: 2,
                    migrate: (value) => ({ ...value, status: 'open' }),
                }],
            },
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });

        const parse = vi.spyOn(JSON, 'parse');
        try {
            await expect(candidate.prepare()).resolves.toBeUndefined();
            activeCredentials = accountB;

            await expect(candidate.retire()).resolves.toBeUndefined();
            expect(encodedBodies).toHaveLength(3);
            expect(adapterBodies).toEqual(encodedBodies);
            expect(parse.mock.calls.filter(([value]) => encodedBodies.includes(value))).toHaveLength(0);
        } finally {
            parse.mockRestore();
        }
    });
});
