import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { PluginError } from '@happier-dev/plugin-sdk';
import { DaemonPluginStructuredMessageActionExecuteResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { RpcHandler } from '@/api/rpc/types';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import * as persistence from '@/persistence';
import * as socketEvents from '@/session/transport/socket/sessionSocketAgentState';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';
import { createCredentialedTargetActionCurrentIntent } from '@/session/actions/approvals/credentialedTargetActionCurrentIntent';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonExternalActionContributedApprovalReplay } from '@/daemon/externalActions/createDaemonExternalActionContributedInvoker';

afterEach(() => vi.restoreAllMocks());

describe('plugin Action current intent through the registered daemon ingress', () => {
    it.each([
        { executionSurface: 'cli', tracked: false },
        { executionSurface: 'agent', tracked: false },
        { executionSurface: 'mcp', tracked: false },
        { executionSurface: 'cli', tracked: true },
    ] as const)('asks for $executionSurface approval before the external plugin handler and honors rejection (tracked $tracked)', async ({ executionSurface, tracked }) => {
        const confidential = executionSurface === 'agent';
        const pluginId = 'acme.current-intent';
        const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'intent-root' };
        const confirmation = { title: 'Apply this change?' };
        const inputSchema = { type: 'object', properties: { value: { type: 'string' }, releaseTag: { type: 'string' }, requestId: { type: 'string' } }, required: ['value', 'releaseTag', 'requestId'], additionalProperties: false };
        const resultSchema = { type: 'object', properties: { applied: { type: 'string' } }, required: ['applied'], additionalProperties: false };
        let applied: unknown;
        let decision: 'approve' | 'reject' = 'approve';
        let stored: TargetActionApprovalRequestV1 | null = null;
        let nextRequestId = 0;
        let artifactId = '';
        const action = { provenance: 'external', source: { kind: 'path' }, pluginId,
            definition: { kindVersion: 1, id: 'apply', title: 'Apply', description: null, safety: 'safe', dangerLevel: 'writesLocal', confirmation,
                execution: { target: 'daemon' }, scopes: ['global'], placements: [], slash: null, bindings: null, examples: null,
                ...(tracked ? { operation: { version: 1 as const, visibility: 'activity' as const, progress: 'reported' as const, presentation: { onStart: 'detail' as const } } } : {}),
                surfaces: { ui: true, agent: true, mcp: true, cli: true, voice: false, rpc: false, api: false, plugin: false },
                inputHints: null, inputSchema, outputSchema: resultSchema, contributionSurfaces: ['ui'], placementBindings: [] },
        } satisfies ResolvedActionContribution;
        const contributes = createResolvedContributionRegistry({ agents: [], actions: [action], occurrenceIdsByPluginId: { [pluginId]: occurrenceId } });
        const targetActionInvocations = createTargetActionInvocationRegistry({
            actions: [{ pluginId, pluginVersion: '1.0.0', occurrenceId, sourceCustody, localId: 'apply',
                definition: { id: 'apply', dangerLevel: 'writesLocal', confirmation, scopes: ['global'], surfaces: ['ui', 'agent', 'mcp', 'cli'], inputSchema, resultSchema,
                    ...(confidential ? { secretInputPaths: ['releaseTag'], secretInputLabels: { releaseTag: 'Release credential' } } : {}) },
                inputParser: input => ({ success: true, data: {
                    value: `${String(Reflect.get(input as object, 'value'))}-normalized`,
                    releaseTag: Reflect.get(input as object, 'releaseTag') ?? 'v1.2.3-public-release',
                    requestId: Reflect.get(input as object, 'requestId') ?? `request-${++nextRequestId}`,
                } }),
                handler: async input => {
                    if (Reflect.get(input as object, 'value') === 'blocked-normalized') {
                        throw new PluginError({ code: 'integration_account_needs_reauth',
                            message: 'Reconnect the integration account before continuing. Authorization: Bearer token-secret-must-not-cross /home/private/operator/credential.json' });
                    }
                    applied = input;
                    return { applied: String(Reflect.get(input as object, 'value')) };
                } }],
            resolveAuthorizationFacts: target => ({ generation: { targetGeneration: target.occurrenceId,
                desiredGeneration: target.occurrenceId, appliedGeneration: target.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
            createServices: createUnavailablePluginServicesFactory(), resolveHostBinding: createTargetActionHostBindingResolver(),
            readCurrentPluginOccurrenceId: id => id === pluginId ? occurrenceId : null,
        });
        // Filesystem package loading/registry leases are the boundary; registration, policy, approval and plugin dispatch stay real.
        const registry = { contributes, targetActionInvocations, generation: 7,
            resolveCurrentPluginApprovalReplayPlacement: async () => ({ serverId: 'server-1', machineId: 'machine-1' }),
            readPluginOccurrenceId: (id: string) => id === pluginId ? occurrenceId : null,
            readPluginSourceCustody: (id: string) => id === pluginId ? sourceCustody : null,
            isPluginOccurrenceCurrent: (id: string, candidate: string) => id === pluginId && candidate === occurrenceId,
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        // Only credential files, HTTP persistence and socket transport are replaced.
        // The production credentialed approval factory, Artifact codecs and strict reader stay real.
        const rows = new Map<string, Record<string, unknown>>();
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token, encryption: null });
        vi.spyOn(socketEvents, 'observeSessionSocketEvents').mockReturnValue({ dispose: async () => {} });
        vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
            if (!url.endsWith('/v1/artifacts') || !input || typeof input !== 'object'
                || typeof input.id !== 'string' || typeof input.body !== 'string') throw new Error('unexpected_artifact_create');
            const envelope = decodePlainArtifactStoredContent(input.body);
            if (!envelope || typeof envelope !== 'object' || !('body' in envelope) || typeof envelope.body !== 'string') throw new Error('invalid_approval_body');
            expect(applied).toBeUndefined();
            stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(envelope.body));
            artifactId = input.id;
            rows.set(input.id, { ...input, ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
                publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            const row = rows.get(url.split('/').at(-1)!);
            if (!row || !stored) throw new Error('unexpected_artifact_read');
            const decided = TargetActionApprovalRequestV1Schema.parse({ ...stored,
                status: decision === 'approve' ? 'approved' : 'rejected',
                decision: { kind: decision, decidedAtMs: Date.now() } });
            return { status: 200, data: { ...row,
                header: encodePlainArtifactStoredContent(buildTargetActionApprovalArtifactHeaderV1(decided)),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(decided) }) } };
        });
        try {
            const handlers = new Map<string, RpcHandler>();
            const operations = createHostActionOperationRuntime({ machineId: 'machine-1', resolveAccountId: async () => 'account-1' });
            registerDaemonContributionRegistryProjectionHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => registry, resolveGeneration: async () => 7, resolveInstalledPackages: async () => [],
                ...(tracked ? { observePluginExecution: operations.observePluginExecution } : {}),
                requestCurrentIntent: async request => {
                    const credentials = await persistence.readStoredCredentials();
                    return credentials ? await createCredentialedTargetActionCurrentIntent(credentials)(request)
                        : { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
                },
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
            if (!handler) throw new Error('missing_plugin_action_handler');
            const request = { machineId: 'machine-1', expectedContributorOccurrenceId: occurrenceId,
                qualifiedActionId: `${pluginId}/apply`, input: { value: 'approved' }, executionSurface };
            if (executionSurface === 'cli') {
                expect(await handler({ ...request, executionSurface: 'ui' })).toMatchObject({ ok: false,
                    code: 'plugin_action_current_intent_unavailable' });
                expect(stored).toBeNull();
            }
            const result = await handler(request);
            if (confidential) expect(result).toEqual({ ok: true, result: { applied: 'approved-normalized' } });
            else {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId, actionId: 'action.invoke' } });
                expect(applied).toBeUndefined();
                const replay = createDaemonExternalActionContributedApprovalReplay({
                    credentials: { token, encryption: null },
                    acquireRuntimeRegistryLease: async () => ({ registry, source: 'ephemeral', durableRevision: -1, release: async () => {} }),
                    isApprovalExecutionOriginCurrent: async () => true,
                    targetActionApprovals: {
                        targetActionApprovalsGet: async () => stored,
                        targetActionApprovalsUpdate: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { ok: true }; },
                    },
                });
                expect(await replay({ artifactId, decision: 'approve' })).toMatchObject({ ok: true,
                    result: { status: 'executed', execution: { ok: true } } });
            }
            expect(stored).toMatchObject({ kind: 'plugin_target_action', requestedSurface: executionSurface,
                qualifiedActionId: `${pluginId}/actions/apply`, input: {
                    value: 'approved-normalized', releaseTag: confidential ? '[REDACTED]' : 'v1.2.3-public-release',
                    requestId: expect.stringMatching(/^request-\d+$/),
                } });
            expect(applied).toMatchObject({ value: 'approved-normalized', releaseTag: 'v1.2.3-public-release',
                requestId: expect.stringMatching(/^request-\d+$/) });
            if (confidential) {
                expect(stored).toMatchObject({ approvalInputCustody: 'live_only',
                    replayPlacement: { serverId: 'server-1', machineId: 'machine-1' } });
                expect(JSON.stringify(stored)).not.toContain('v1.2.3-public-release');
            } else { expect(applied).toEqual(stored?.input); }
            applied = undefined;
            // Confidential invocation exercises blocking settlement; public inputs
            // above prove deferred replay through the same handler and parser.
            if (confidential) {
                const blocked = DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(await handler({ ...request, input: { value: 'blocked' } }));
                expect(blocked).toMatchObject({
                    ok: false, code: 'integration_account_needs_reauth',
                    message: expect.stringContaining('Reconnect the integration account before continuing.'),
                });
                expect(JSON.stringify(blocked)).not.toContain('token-secret-must-not-cross');
                expect(JSON.stringify(blocked)).not.toContain('/home/private/operator/credential.json');
                applied = undefined;
                decision = 'reject';
                expect(await handler({ ...request, input: { value: 'rejected' } })).toMatchObject({ ok: false, code: 'plugin_action_current_intent_rejected' });
            } else {
                expect(await handler({ ...request, input: { value: 'rejected' } })).toMatchObject({ ok: true,
                    result: { kind: 'approval_request_created', artifactId } });
                const replay = createDaemonExternalActionContributedApprovalReplay({ credentials: { token, encryption: null },
                    targetActionApprovals: {
                        targetActionApprovalsGet: async () => stored,
                        targetActionApprovalsUpdate: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { ok: true }; },
                    },
                });
                expect(await replay({ artifactId, decision: 'reject' })).toMatchObject({ ok: true, result: { status: 'rejected' } });
            }
            expect(applied).toBeUndefined();
            if (executionSurface === 'cli') {
                const artifactCount = rows.size;
                vi.mocked(persistence.readStoredCredentials).mockResolvedValue(null);
                expect(await handler(request)).toMatchObject({ ok: false, code: 'plugin_action_current_intent_unavailable' });
                expect(rows.size).toBe(artifactCount);
                expect(applied).toBeUndefined();
                const unbound = new Map<string, RpcHandler>();
                registerDaemonContributionRegistryProjectionHandler({ registerHandler: (method, handler) => { unbound.set(method, handler); } }, {
                    resolveRuntimeRegistry: async () => registry, resolveGeneration: async () => 7, resolveInstalledPackages: async () => [],
                });
                expect(await unbound.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)?.(request))
                    .toMatchObject({ ok: false, code: 'plugin_action_current_intent_unavailable' });
                expect(rows.size).toBe(artifactCount);
            }
        } finally { targetActionInvocations.dispose(); }
    });
});
