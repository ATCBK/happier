import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { RPC_METHODS } from '@happier-dev/protocol';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

const packaged = vi.hoisted(() => ({ bytes: new Uint8Array(), githubBytes: new Uint8Array(), machineRpc: vi.fn() }));

// Only packaged-asset IO is substituted. Compile the current authored Account
// entry with its production compiler; admission, activation and dispatch stay real.
vi.mock('./generatedBundledPluginUiArtifacts', async () => {
    const { resolve, join } = await import('node:path');
    const { compileUniversalPluginUiCommonJs } = await import('../../../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler');
    const { readWorkspacePackages, packageNameOfSpecifier, resolveWorkspaceSource } = await import('../../../../../../../packages/cli-common/sourceRuntimeEntries.mjs');
    // Load foreign-program source under Vitest without making the UI compiler
    // root the daemon entry's whole source graph; the public schema admits it.
    const triageManifestSource = '../../../../../../../packages/plugins/triage/src/manifest';
    const { PLUGIN_MANIFEST } = await vi.importActual<Readonly<{ PLUGIN_MANIFEST: unknown }>>(triageManifestSource);
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1,
        PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui');
    const { normalizePluginAccountCollectionContractV1 } = await import('@happier-dev/protocol');
    const root = resolve(process.cwd(), '../..');
    const packages = await readWorkspacePackages(root);
    const projectRoot = join(root, 'packages/plugins/triage');
    const compiled = await compileUniversalPluginUiCommonJs({ projectRoot,
        entryPath: join(projectRoot, 'src/accountRuntime.ts'), artifactId: 'triage-account-runtime',
        requestedExports: ['activate'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    packaged.bytes = compiled.bytes;
    const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
    const collectionContracts = manifest.contributes.accountCollections.map(contribution => {
        const contract = normalizePluginAccountCollectionContractV1({ pluginId: manifest.id, contribution });
        return { pluginId: contract.pluginId, collectionId: contract.collectionId,
            schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
    });
    const relativePath = 'react-native/triage-account-runtime/entry.cjs.bundle';
    const artifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'triage-account-runtime', tier: 'reactNative',
        entry: relativePath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes: compiled.bytes }]),
        files: [{ relativePath, digest: computePluginUiArtifactSha256DigestV1(compiled.bytes), byteSize: compiled.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0' });
    const uiDeclaration = { pluginId: manifest.id, pluginVersion: manifest.version, displayName: manifest.displayName,
        packageName: '@happier-dev/plugins-triage', normalizedManifest: manifest, artifactGraphs: [artifact],
        collectionContracts,
        entriesById: projectPluginPortableUiDeclarationsV1(manifest, [artifact]),
        declaredExecution: { daemonActions: true, contributionPoints: true } };
    const githubManifestSource = '../../../../../../../packages/plugins/scm-github/src/manifest';
    const githubModule = await vi.importActual<Readonly<{ PLUGIN_MANIFEST: unknown }>>(githubManifestSource);
    const githubManifest = PluginPortableReleaseManifestV1Schema.parse(githubModule.PLUGIN_MANIFEST);
    const githubRoot = join(root, 'packages/plugins/scm-github');
    const githubCompiled = await compileUniversalPluginUiCommonJs({ projectRoot: githubRoot,
        entryPath: join(githubRoot, 'src/ui/renderSurface.tsx'), artifactId: 'github-detail-native',
        requestedExports: ['renderSurface'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    packaged.githubBytes = githubCompiled.bytes;
    const githubPath = 'react-native/github-detail-native/entry.cjs.bundle';
    const githubArtifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'github-detail-native', tier: 'reactNative',
        entry: githubPath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: githubPath, bytes: githubCompiled.bytes }]),
        files: [{ relativePath: githubPath, digest: computePluginUiArtifactSha256DigestV1(githubCompiled.bytes), byteSize: githubCompiled.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' });
    const githubDeclaration = { pluginId: githubManifest.id, pluginVersion: githubManifest.version, displayName: githubManifest.displayName,
        packageName: '@happier-dev/plugins-scm-github', normalizedManifest: githubManifest, artifactGraphs: [githubArtifact],
        entriesById: projectPluginPortableUiDeclarationsV1(githubManifest, [githubArtifact]) };
    return { BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [{ pluginId: manifest.id, releaseVersion: manifest.version,
        artifactId: artifact.artifactId, tier: artifact.tier, digest: artifact.digest, artifactGraph: artifact,
        uiDeclaration, files: [{ relativePath, asset: 1 }] }, { pluginId: githubManifest.id, releaseVersion: githubManifest.version,
        artifactId: githubArtifact.artifactId, tier: githubArtifact.tier, digest: githubArtifact.digest, artifactGraph: githubArtifact,
        uiDeclaration: githubDeclaration, files: [{ relativePath: githubPath, asset: 2 }] }], BUNDLED_PLUGIN_BRAND_MARKS: [] };
});
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({ localUri: `file:///test-app/${asset}.bundle`,
    downloadAsync: async () => undefined }) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    constructor(private readonly uri: string) {}
    bytes = async () => this.uri.endsWith('/2.bundle') ? packaged.githubBytes : packaged.bytes;
} }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    // The user-presentation boundary approves the real present-user gate.
    return createModalModuleMock({ confirmResult: true }).module;
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async input => {
        const reply = packaged.machineRpc(input);
        if (reply !== undefined) return reply;
        throw new Error('No Machine is selected');
    });
});

const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { AppShellPluginUiProjectionProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { readCurrentAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } = await import('./projection');
const { resolvePluginUiClientActionRegistration } = await import('@/components/plugins/reactNative/clientExecutableContributions');
const { readPluginUiAccountExecutableOrigin } = await import('@/components/plugins/reactNative/executableModuleHost');
const { createPluginUiProjectedActionResolver } = await import('@/sync/domains/plugins/ui/projection');
const { createBoundPluginSurfaceController } = await import('@/components/plugins/surfaces/boundPluginSurfaceController');
const { BUNDLED_PLUGIN_UI_APP_ARTIFACTS } = await import('./generatedBundledPluginUiArtifacts');
const { PluginAccountAvailabilityIntentReadResponseV1Schema } = await import('@happier-dev/protocol/plugins/availability');
const { normalizePluginAccountCollectionContractV1, PluginCollectionGetRequestV1Schema, PluginCollectionQueryRequestV1Schema,
    PluginCollectionContractReadRequestV1Schema, PluginCollectionRowV1Schema } = await import('@happier-dev/protocol');
const { scopedHomeActionExecutor } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
const { createTestkitCorpusCollections } = await import('../../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support');
const { administerConfiguredSourceInstance } = await import('../../../../../../../packages/plugins/triage/src/corpus/configuration/administerConfiguredSourceInstance');
const { INTERNAL_TASK_DRAFT_V1, INTERNAL_TASK_SOURCE_V1 } = await import('../../../../../../../packages/plugins/triage/src/internalTasks/source');
const { encodePluginCollectionLogicalValueV1 } = await import('@happier-dev/protocol/plugins/data/collectionLogicalCodecV1');
const { compilePluginJsonSchema, isValidPluginJsonSchemaValue } = await import('@happier-dev/plugin-sdk/manifest');
const { TriageTaskWriteResultV1Schema } = await import('@happier-dev/triage-protocol/v1');
const { GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1, GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 } = await import('../../../../../../../packages/plugins/scm-github/src/triage/contribution');
const { encodeGithubTriageConfiguration, GITHUB_TRIAGE_ACCOUNT_SCOPE_V1 } = await import('../../../../../../../packages/plugins/scm-github/src/triage/configuration');
const { GITHUB_TEST_ACCOUNT } = await import('../../../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support');
const { GITHUB_PLUGIN_ID } = await import('../../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts');
const { Modal } = await import('@/modal');
const kvMutationsSchema = z.strictObject({ mutations: z.array(z.strictObject({
    key: z.string(), value: z.nullable(z.string()), version: z.number(),
})) });

afterEach(async () => {
    clearPluginAccountAvailabilityProjection();
    await account.reset();
    storage.setState(storage.getInitialState(), true);
    packaged.machineRpc.mockReset();
    vi.mocked(Modal.show).mockClear();
});

it.each(['mixed sources', 'personal CRUD', 'unavailable optional Machine', 'available Machine sources'] as const)(
    'runs actual Triage through the UI Account dispatcher: %s', async scenario => {
    const availableMachine = scenario === 'available Machine sources';
    const withMachine = scenario === 'unavailable optional Machine' || availableMachine;
    const withGithub = scenario === 'mixed sources' || availableMachine;
    const machineId = 'optional-unavailable-machine';
    await account.restore({ machines: withMachine ? [createMachineFixture({ id: machineId, active: availableMachine, activeAt: availableMachine ? Date.now() : 0 })] : [], serverIdentityId: 'srv_triage_account_dispatch',
        features: createRootLayoutFeaturesResponse({ features: { plugins: { enabled: true,
            ui: { enabled: true, hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } } } } }) });
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    const declaration = BUNDLED_PLUGIN_UI_APP_ARTIFACTS[0]!.uiDeclaration!;
    if (availableMachine) {
        const github = BUNDLED_PLUGIN_UI_APP_ARTIFACTS[1]!.uiDeclaration!;
        const manifest = github.normalizedManifest!;
        const occurrenceId = 'github-current';
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'github-source-root' };
        const executionOrigin = { serverIdentityId: 'srv_triage_account_dispatch', sourceRef: {
            machineId, pluginId: manifest.id, sourceCustody,
        } };
        const { PluginProjectionV2Schema, RPC_METHODS } = await import('@happier-dev/protocol');
        const { TriageScanResultV1Schema, TriageListInstancesResultV1Schema } = await import('@happier-dev/triage-protocol/v1');
        const { DaemonPluginUiTargetedContributionsReadResponseSchema,
            DaemonPluginActionSchemasReadRequestSchema, DaemonPluginActionSchemasReadResponseSchema,
        } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { DaemonPluginStructuredMessageActionExecuteRequestSchema } = await import('@happier-dev/protocol/plugins/actions/daemonInvocationV1');
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [manifest.id]: { id: manifest.id, displayName: manifest.displayName,
                version: manifest.version, enabled: true, source: { kind: 'local', locator: '/plugins/scm-github' },
                occurrenceId, sourceCustody, executionOrigin, declaresContributionPoints: false } },
            // The daemon DTO is the genuine RPC boundary. The CLI projector's
            // @/ imports belong to its separate process; keep this strict wire
            // fixture to its published fields, not author-only schemas/access declarations.
            actionsById: Object.fromEntries(manifest.contributes.actions.map(action => [`${manifest.id}/${action.id}`, {
                id: action.id, title: action.title, description: action.description,
                scopes: action.scopes, surfaces: action.surfaces, execution: action.execution,
                placementBindings: action.placementBindings, dangerLevel: action.dangerLevel,
                operation: action.operation, confirmation: action.confirmation, confirmationWhen: action.confirmationWhen,
                inputHints: action.inputHints, priority: action.priority, icon: action.icon, slash: action.slash,
                pluginId: manifest.id, occurrenceId, executionOrigin, available: true,
                authorization: { generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId, appliedGeneration: occurrenceId },
                    resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] },
            }])),
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(Object.entries(github.entriesById)
                .map(([id, entry]) => [id, { ...entry, occurrenceId, executionOrigin }])) } },
        });
        const targeted = DaemonPluginUiTargetedContributionsReadResponseSchema.parse({ status: 'sourceDeclarations',
            pluginId: declaration.pluginId, sourceDeclarations: [{ manifest: { id: manifest.id, contributes: {
                actions: manifest.contributes.actions, pluginContributionPoints: manifest.contributes.pluginContributionPoints,
                targetedPluginContributions: manifest.contributes.targetedPluginContributions.filter(entry => entry.target.pluginId === declaration.pluginId),
                ui: { renderers: manifest.contributes.ui.renderers },
            } }, occurrenceId, sourceCustody }] });
        const scanResult = TriageScanResultV1Schema.parse({ kind: 'complete', observations: [], evidence: { kind: 'walkFinished' } });
        packaged.machineRpc.mockImplementation(request => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { protocolVersion: 1, projection };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return targeted;
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
                const query = DaemonPluginActionSchemasReadRequestSchema.parse(request.payload);
                expect(query.machineId).toBe(machineId);
                expect(query.expectedOccurrenceId).toBe(occurrenceId);
                const action = manifest.contributes.actions.find(row => `${manifest.id}/${row.id}` === query.qualifiedActionId);
                if (!action) throw new Error('Schema request must name a declared GitHub Action');
                return DaemonPluginActionSchemasReadResponseSchema.parse({ ok: true,
                    inputSchema: action.inputSchema, outputSchema: action.resultSchema });
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                const invocation = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
                expect(invocation).toMatchObject({ machineId, expectedContributorOccurrenceId: occurrenceId });
                if (invocation.qualifiedActionId === `${manifest.id}/triage/list-github-instances`) {
                    expect(invocation.invocation).toMatchObject({ kind: 'mountedPluginSurface',
                        mountedBinding: { pluginId: manifest.id, occurrenceId } });
                    return { ok: true, result: TriageListInstancesResultV1Schema.parse({ kind: 'complete', candidates: [], failures: [] }) };
                }
                expect(invocation.qualifiedActionId).toBe(`${manifest.id}/triage/scan-github`);
                return { ok: true, result: scanResult };
            }
            throw new Error(`Unexpected Machine method ${request.method}`);
        });
    }
    const contracts = declaration.normalizedManifest!.contributes.accountCollections.map(contribution =>
        normalizePluginAccountCollectionContractV1({ pluginId: declaration.pluginId, contribution }));
    const rows = new Map<string, ReturnType<typeof PluginCollectionRowV1Schema.parse>>();
    // Produce the persisted source fixture through its canonical writer and
    // logical wire codec, outside the read/dispatch corridor under test.
    const corpus = createTestkitCorpusCollections();
    const configured = await administerConfiguredSourceInstance({ collections: corpus.collections,
        source: INTERNAL_TASK_SOURCE_V1, declaredPurpose: 'tasks', request: { kind: 'create', draft: INTERNAL_TASK_DRAFT_V1 },
        nowMs: 1, mintSourceInstanceId: () => '11111111-1111-4111-8111-111111111111' });
    expect(configured.kind).toBe('active');
    if (withGithub) {
        expect((await administerConfiguredSourceInstance({ collections: corpus.collections,
            source: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 },
            declaredPurpose: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose,
            request: { kind: 'create', draft: { v: 1, binding: { purpose: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose,
                account: GITHUB_TEST_ACCOUNT }, localInstanceKey: 'github.com', keyStability: 'locatorDerived',
                configuration: { v: 1, token: encodeGithubTriageConfiguration(GITHUB_TRIAGE_ACCOUNT_SCOPE_V1)! },
                locator: { v: 1, displayLabel: 'GitHub' } } },
            nowMs: 1, mintSourceInstanceId: () => '22222222-2222-4222-8222-222222222222',
        })).kind).toBe('active');
    }
    const persisted = await corpus.collections.sourceInstances.query({ index: 'by-lifecycle', order: 'asc' });
    const sourceContract = contracts.find(contract => contract.collectionId === 'source-instances')!;
    const validate = compilePluginJsonSchema(sourceContract.schema);
    for (const row of persisted.rows) {
        const encoded = encodePluginCollectionLogicalValueV1({ contract: sourceContract, value: row.value,
            isValidLogicalValue: value => isValidPluginJsonSchemaValue(validate, value), encryptionMode: 'plain', material: null,
            randomBytes: length => new Uint8Array(length) });
        if (encoded.status !== 'encoded') throw new Error(`Invalid produced source fixture: ${encoded.reason}`);
        rows.set(encoded.rowId, PluginCollectionRowV1Schema.parse({ rowId: encoded.rowId, content: encoded.content,
            projection: encoded.projection, revision: row.revision }));
    }
    const todoRows = new Map([
        { key: 'todo.index', version: 1, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { undoneOrder: ['personal-task'], completedOrder: [] } }) },
        { key: 'todo.personal-task', version: 1, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: {
            id: 'personal-task', title: 'Account personal task', done: false, createdAt: 1, updatedAt: 1 } }) },
    ].map(row => [row.key, row]));
    const publishTodoRow = (key: string) => account.home.answer(account.serverId, `GET /v1/kv/${key}`, {
        select: () => todoRows.has(key) ? { body: todoRows.get(key) } : { status: 404 },
    });
    account.home.answer(account.serverId, 'GET /v1/kv', { select: (_body, request) => {
        const prefix = new URL(request.url).searchParams.get('prefix') ?? '';
        return { body: { items: [...todoRows.values()].filter(row => row.key.startsWith(prefix)) } };
    } });
    for (const row of todoRows.values()) publishTodoRow(row.key);
    account.home.answer(account.serverId, 'POST /v1/kv', { select: value => {
        const { mutations } = kvMutationsSchema.parse(value);
        const conflicts = mutations.filter(row => row.version !== (todoRows.get(row.key)?.version ?? -1));
        if (conflicts.length) return { status: 409, body: { success: false, errors: conflicts.map(row => ({
            key: row.key, error: 'version-mismatch', version: todoRows.get(row.key)?.version ?? -1,
            value: todoRows.get(row.key)?.value ?? null,
        })) } };
        const results = mutations.map(row => {
            const version = row.version + 1;
            if (row.value === null) todoRows.delete(row.key);
            else todoRows.set(row.key, { key: row.key, value: row.value, version });
            publishTodoRow(row.key);
            return { key: row.key, version };
        });
        return { body: { success: true, results } };
    } });
    account.home.answer(account.serverId, 'POST /v1/plugins/data/contract', { select: value => {
        const { ref } = PluginCollectionContractReadRequestV1Schema.parse(value);
        const contract = contracts.find(contract => contract.collectionId === ref.collectionId);
        if (!contract) throw new Error('Unexpected Triage Collection');
        return { body: { access: 'writable', contract } };
    } });
    account.home.answer(account.serverId, 'POST /v1/plugins/data/get', { select: value => {
        const request = PluginCollectionGetRequestV1Schema.parse(value);
        return { body: { row: rows.get(request.rowId) ?? null, absenceEpoch: 0 } };
    } });
    account.home.answer(account.serverId, 'POST /v1/plugins/data/query', { select: value => {
        const request = PluginCollectionQueryRequestV1Schema.parse(value);
        const index = contracts.find(contract => contract.collectionId === request.collectionId)?.indexes.find(index => index.id === request.indexId);
        if (!index) throw new Error('Unexpected Triage Collection index');
        return { body: { rows: [...rows.values()].filter(row => request.prefix.every((part, position) =>
            row.projection[index.fields[position]!.field] === part)), changeCursor: 1 } };
    } });
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: declaration.pluginId,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                hostingCapability: { enabled: false }, intent: { pluginId: declaration.pluginId, desiredVersion: null,
                    enabled: true, offlineUiHosting: 'disabled', writableCollections: declaration.collectionContracts, revision: 'claimed' },
                release: null, packageAssets: [], uiArtifacts: [] }) }, { pluginId: GITHUB_PLUGIN_ID,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                hostingCapability: { enabled: false }, intent: { pluginId: GITHUB_PLUGIN_ID, desiredVersion: null,
                    enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'github-catalog' },
                release: null, packageAssets: [], uiArtifacts: [] }) }] } });
    const screen = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><></></AppShellPluginUiProjectionProvider>);
    try {
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            const action = readCurrentAppShellPluginUiProjection()?.actionsById['happier.triage/sources/read-configured-v1'];
            expect(action && resolvePluginUiClientActionRegistration({ action, platform: 'web' })).not.toBeNull();
        });
        const projection = readCurrentAppShellPluginUiProjection()!;
        const action = projection.actionsById['happier.triage/sources/read-configured-v1']!;
        const origin = readPluginUiAccountExecutableOrigin(action)!;
        const controller = createBoundPluginSurfaceController({ facts: {
            pluginId: 'happier.triage', contributionId: 'tasks', surfaceId: 'surfacePlacement:happier.triage:tasks',
            placement: 'browserSurface', platform: 'web', channel: 'internal', serverId: lifetime.scope.serverId,
            machineId: withMachine ? machineId : null,
            accountLifetime: lifetime, occurrenceId: origin.custodyId, accountExecutionOrigin: origin,
            pluginUiProjection: projection,
            resolveContributedAction: identity => createPluginUiProjectedActionResolver(
                readCurrentAppShellPluginUiProjection()?.actionsById,
            )(identity),
            interactionEnabled: true, daemonInteractionEnabled: availableMachine,
        }, binding: { executeHostAction: scopedHomeActionExecutor(lifetime.scope) } });
        const dispatch = controller.dispatchAction;
        try {
            if (scenario !== 'personal CRUD') {
                expect(await dispatch('sources/read-configured-v1', { v: 1 })).toMatchObject({ kind: 'read', instances: [{ lifecycle: 'active' }] });
                const result = await dispatch('tasks/list-v1', { v: 1,
                    sources: { kind: 'allConfigured' }, limit: 10, order: 'newest', tasks: { completedSinceMs: 0 } });
                expect(result).toMatchObject({ window: { rows: [{ entryRef: { entryId: 'personal-task' } }] } });
                if (withGithub && !availableMachine) expect(result).toMatchObject({ configuredSources: expect.arrayContaining([
                    expect.objectContaining({ sourceInstanceId: '11111111-1111-4111-8111-111111111111' }),
                    expect.objectContaining({ sourceInstanceId: '22222222-2222-4222-8222-222222222222' }),
                ]), window: { lanes: expect.arrayContaining([
                    expect.objectContaining({ source: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 },
                        health: expect.objectContaining({ kind: 'unavailable',
                            error: expect.objectContaining({ code: 'plugin_action_machine_required' }) }) }),
                ]) } });
                if (availableMachine) {
                    expect(packaged.machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toBe(true);
                    expect(result).toMatchObject({ window: { lanes: expect.arrayContaining([
                        expect.objectContaining({ source: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 },
                            health: expect.objectContaining({ kind: 'walkFinished' }) }),
                    ]) } });
                    // The exact Settings Action shares the real schema/RPC dispatcher
                    // with the aggregate, while keeping its own mounted GitHub caller.
                    // This establishes the controller contract, not physical Host or
                    // Administration-selection readiness.
                    const { readReusableDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
                    const { readPluginSurfaceMountBinding } = await import('@/components/plugins/surfaces/pluginSurfaceMountBinding');
                    const cached = readReusableDaemonMergedProjectionCacheEntry({ machineId,
                        serverId: lifetime.scope.serverId, accountLifetime: lifetime });
                    expect(cached?.kind).toBe('ready');
                    if (cached?.kind !== 'ready') throw new Error('Expected the current Machine projection');
                    const exact = cached.inputs.pluginUiProjection;
                    const page = Object.values(exact.settingsPagesById).find(row => row.pluginId === GITHUB_PLUGIN_ID
                        && row.descriptorId === GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.settingsPageId);
                    if (!page) throw new Error('Expected the authored GitHub Settings page');
                    const mounted = readPluginSurfaceMountBinding({ descriptor: page, renderer: page.renderer });
                    if (mounted?.kind !== 'destination') throw new Error('Expected the Settings destination binding');
                    const action = exact.actionsById[`${GITHUB_PLUGIN_ID}/triage/list-github-instances`];
                    if (!action?.occurrenceId) throw new Error('Expected exact GitHub Action custody');
                    let current = true;
                    const settingsController = createBoundPluginSurfaceController({ facts: {
                        pluginId: page.pluginId, contributionId: mounted.destinationBinding.destination.localId,
                        surfaceId: page.id, placement: mounted.destinationBinding.surfaceContextPlacement,
                        platform: 'web', channel: 'internal', machineId, serverId: lifetime.scope.serverId,
                        accountLifetime: lifetime, occurrenceId: action.occurrenceId,
                        executionOrigin: action.executionOrigin, pluginUiProjection: exact,
                        resolveContributedAction: createPluginUiProjectedActionResolver(exact.actionsById),
                        interactionEnabled: true, daemonInteractionEnabled: true,
                    }, binding: { executeHostAction: scopedHomeActionExecutor(lifetime.scope),
                        isExecutionOriginCurrent: () => current } });
                    try {
                        expect(await settingsController.dispatchAction('triage/list-github-instances', { v: 1 }))
                            .toEqual({ kind: 'complete', candidates: [], failures: [] });
                        const before = packaged.machineRpc.mock.calls.length;
                        current = false;
                        expect(await settingsController.dispatchAction('triage/list-github-instances', { v: 1 }))
                            .toMatchObject({ code: 'unavailable', diagnostics: ['plugin_surface_contributed_action_unavailable'] });
                        expect(packaged.machineRpc.mock.calls).toHaveLength(before);
                    } finally { settingsController.dispose(); }
                }
            } else {
                const created = TriageTaskWriteResultV1Schema.parse(await dispatch('tasks/create-v1', {
                    v: 1, source: INTERNAL_TASK_SOURCE_V1, sourceInstanceId: '11111111-1111-4111-8111-111111111111',
                    kindId: 'task', fields: { title: 'Created through Account UI' },
                }));
                expect(created.kind).toBe('applied');
                if (created.kind !== 'applied') throw new Error('Account UI create did not apply');
                expect(created.observation.snapshot.title).toBe('Created through Account UI');
                const entryRef = { source: INTERNAL_TASK_SOURCE_V1, ...created.observation.localRef };
                const address = { v: 1, sourceInstanceId: '11111111-1111-4111-8111-111111111111', entryRef };
                expect(await dispatch('tasks/edit-v1', { ...address,
                    fields: { title: 'Edited through Account UI' } })).toMatchObject({ kind: 'applied',
                        observation: { snapshot: { title: 'Edited through Account UI' } } });
                expect(await dispatch('tasks/transition-v1', { ...address,
                    transitionId: 'completed' })).toMatchObject({ kind: 'applied',
                        observation: { snapshot: { state: { presentation: 'resolved' } } } });
                expect(await dispatch('entries/reobserve-v1', address)).toMatchObject({ kind: 'observed',
                    observation: { outcome: { snapshot: { title: 'Edited through Account UI', state: { presentation: 'resolved' } } } } });
                expect(vi.mocked(Modal.show).mock.calls.filter(([config]) =>
                    config.chrome?.testID === 'app-shell-transient-interaction-dialog')).toHaveLength(3);
                expect([...todoRows.keys()].filter(key => key !== 'todo.index')).toHaveLength(2);
            }
            if (!withMachine) expect(packaged.machineRpc).not.toHaveBeenCalled();
        } finally { controller.dispose(); }
    } finally { await screen.unmount(); }
});
