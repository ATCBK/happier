import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildQualifiedPluginContributionKey, PluginJsonValueV2Schema } from '@happier-dev/protocol';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { createDeferred } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { machinePluginStructuredMessageActionExecute, resetMachineProjectionReadsForTests } from '@/sync/ops/machineContributionRegistryProjection';
import { createPluginSurfaceAccountActionServices } from './pluginSurfaceAccountActionServices';

// The Machine RPC is the physical boundary. Manifest parsing, declaration
// merging, targeted admission, observation and handle currentness stay real.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpc,
}));

const inputSchema = defineProtocolObject({ id: defineProtocolString() }, { policy: 'closed' });
const resultSchema = defineProtocolObject({ accepted: defineProtocolLiteral(true) }, { policy: 'closed' });
const protocol = defineContributionProtocol({ id: 'external-source', version: 1, operations: {
    inspect: { required: true, input: { kind: 'protocolDefined', schema: inputSchema }, resultSchema,
        action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
} });
const target = definePlugin({ id: 'example.account-target', version: '1.0.0',
    contributionPoints: { sources: protocol.point() } });
const source = definePlugin({ id: 'example.machine-source', version: '1.0.0', actions: {
    inspect: { title: 'Inspect', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
        inputSchema, resultSchema, run: async () => ({ accepted: true as const }) },
}, contributesTo: { 'example.account-target': { sources: {
    personal: protocol.contribute({ operations: { inspect: protocol.operations.inspect.bind('inspect') } }),
} } } });

describe('Account Action targeted-contribution services', () => {
    it('does not retire a current Machine operation when a separate declaration read is canceled', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://account-targeted-cancellation.test', accountId: 'alice' }],
            route: () => undefined });
        const executionStarted = createDeferred<void>();
        const releaseExecution = createDeferred<void>();
        const rpcStarted = createDeferred<void>();
        const releaseRpc = createDeferred<void>();
        const cancellation = new AbortController();
        let owner: ReturnType<typeof createPluginSurfaceAccountActionServices> | undefined;
        let observation: ReturnType<ReturnType<typeof createPluginSurfaceAccountActionServices>['services']['targetedContributions']['observeForSelf']> | undefined;
        try {
            resetMachineProjectionReadsForTests();
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('The served Home must establish its Account lifetime');
            const parsedTarget = ingestPluginManifestV2(target.manifest);
            if (!parsedTarget.ok) throw new Error(JSON.stringify(parsedTarget.diagnostics));
            replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
                availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: target.manifest.id, response: {
                    availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                    intent: { pluginId: target.manifest.id, desiredVersion: target.manifest.version, enabled: true,
                        offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                    release: { ref: { pluginId: target.manifest.id, version: target.manifest.version },
                        archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: parsedTarget.manifest,
                        collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
                } }],
            } });
            const selected = readPluginAccountAvailability(lifetime.scope).readCurrentAccountExecution(target.manifest.id);
            if (selected.kind !== 'available') throw new Error('The current Account target must be selected');
            const parsed = ingestPluginManifestV2(source.manifest);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
            const response = { status: 'sourceDeclarations', pluginId: target.manifest.id, sourceDeclarations: [{
                occurrenceId: 'machine-source-current', sourceCustody: { kind: 'development', registeredRootId: 'machine-source-root' },
                manifest: { id: parsed.manifest.id, contributes: { actions: parsed.manifest.contributes.actions,
                    pluginContributionPoints: [], targetedPluginContributions: parsed.manifest.contributes.targetedPluginContributions,
                    ui: { renderers: parsed.manifest.contributes.ui.renderers } } },
            }] };
            let holdRpc = false;
            let executedRequest: ReturnType<typeof DaemonPluginStructuredMessageActionExecuteRequestSchema.parse> | undefined;
            machineRpc.mockImplementation(async (request: Readonly<{ method: string; payload: unknown; onIssued?: () => void }>) => {
                if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                    // The real transport's final-currentness fence runs at
                    // physical issuance, before this boundary accepts an effect.
                    request.onIssued?.();
                    executedRequest = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
                    return { ok: true, result: { accepted: true } };
                }
                if (request.method !== RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) throw new Error('Unexpected Machine RPC');
                if (holdRpc) { rpcStarted.resolve(); await releaseRpc.promise; }
                return response;
            });
            owner = createPluginSurfaceAccountActionServices({ pluginId: target.manifest.id,
                occurrenceId: selected.custodyId, sourceCustody: selected.sourceCustody, accountLifetime: lifetime,
                signal: new AbortController().signal, isCurrent: () => true,
                machine: { machineId: 'machine-1', serverId: lifetime.scope.serverId },
                // Hold the physical Action transport until the independent
                // observation has canceled, retaining its real issuance fence.
                execute: async (action, value, options) => {
                    executionStarted.resolve();
                    await releaseExecution.promise;
                    if (typeof action === 'string' || !options.expectedContributorOccurrenceId) throw new Error('Expected an admitted source Action');
                    const result = await machinePluginStructuredMessageActionExecute('machine-1', {
                        serverId: lifetime.scope.serverId, accountLifetime: lifetime,
                        qualifiedActionId: buildQualifiedPluginContributionKey(action), input: PluginJsonValueV2Schema.parse(value),
                        expectedContributorOccurrenceId: options.expectedContributorOccurrenceId,
                        executionSurface: 'ui', signal: options.signal, isCurrent: options.isCurrent,
                    });
                    if (!result.supported || !result.result.ok) throw new Error('Machine Action transport refused');
                    return result.result.result;
                },
            });
            const currentObservation = owner.services.targetedContributions.observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
            observation = currentObservation;
            const snapshot = await currentObservation.readCurrent();
            expect(snapshot.contributions).toHaveLength(1);
            const operation = snapshot.contributions[0]!.operations.inspect;
            expect(operation.identity.contributor.occurrenceId).toBe('machine-source-current');
            const executing = owner.services.actions.executeAdmittedTargetedOperation(operation, { id: 'personal' });
            // Attach rejection handling before driving the competing read.
            const completed = expect(executing).resolves.toEqual({ accepted: true });
            await executionStarted.promise;
            holdRpc = true;
            const canceledRead = currentObservation.readCurrent({ signal: cancellation.signal });
            const canceled = expect(canceledRead).rejects.toMatchObject({ code: 'plugin_targeted_contributions_aborted' });
            await rpcStarted.promise;
            cancellation.abort();
            await canceled;
            releaseRpc.resolve();
            await releaseRpc.promise;
            releaseExecution.resolve();
            await completed;
            expect(executedRequest).toMatchObject({ qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: source.manifest.id, localId: 'inspect' }),
                expectedContributorOccurrenceId: 'machine-source-current', input: { id: 'personal' } });
        } finally {
            cancellation.abort(); releaseRpc.resolve(); releaseExecution.resolve();
            observation?.dispose(); owner?.dispose(); machineRpc.mockReset();
            resetMachineProjectionReadsForTests();
            await home.dispose();
        }
    });
});
