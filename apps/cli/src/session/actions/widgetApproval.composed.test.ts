import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { ApprovalRequestV2Schema, buildApprovalRequestArtifactHeaderV1, ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent, decodePlainArtifactStoredContent, FeaturesResponseSchema, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { createRegistryInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import * as daemonControl from '@/daemon/controlClient';

it('replays approved installed Board inputs on the hosting Session without an ambient CLI Session', async () => {
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://widget-approval.test' });
    const accountId = 'widget-owner';
    const serverId = 'srv_widget_approval';
    const machineId = 'counter-machine';
    const sessionId = 'c000000000000000000000066';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const pluginId = 'example.widgets';
    const inputType = { pluginId, localId: 'count-kind' };
    const occurrenceId = `${pluginId}:66`;
    const type = { id: inputType.localId, title: 'Count', semantic: 'count-kind',
        valueSchema: { type: 'string' as const, enum: ['files', 'folders'] }, options: { resource: 'count-kinds' } };
    const binding = normalizePluginUiInlineSurfaceBindingV1({ pluginId, surfaceId: 'counter', rendererId: 'counter', role: 'widget', target: { kind: 'app' } });
    if (!binding) throw new Error('Expected widget binding');
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {
        pluginUi: { family: 'pluginUi', entriesById: { counter: { id: 'counter', pluginId, contributionKind: 'surfacePlacement',
            descriptorId: 'counter', occurrenceId, binding, target: binding.target, display: { title: 'Directory count' },
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            inputs: { fields: [{ path: 'filter', title: 'Count', widget: 'select', required: true, inputType }] },
            inputSchema: { type: 'object', properties: { filter: type.valueSchema }, required: ['filter'], additionalProperties: false },
        } } }, inputTypes: { family: 'inputTypes', entriesById: { [`${pluginId}/count-kind`]: {
            id: `${pluginId}/count-kind`, pluginId, pluginVersion: '1.0.0', occurrenceId, definition: type,
        } } },
    } });
    const registry = createResolvedContributionRegistry({ occurrenceIdsByPluginId: { [pluginId]: occurrenceId },
        inputTypes: [{ provenance: 'external', source: { kind: 'path' }, pluginId, identity: inputType,
            manifestPath: '/plugins/widgets/plugin.json', definition: type }],
        resources: [{ provenance: 'external', source: { kind: 'path' }, pluginId,
            definition: { id: 'count-kinds', source: 'dynamic', kind: 'config', scope: 'global', contentType: 'application/json' } }],
    });
    // Only Home HTTP, Machine RPC and the plugin Resource transport are replaced.
    // The CLI composition, approval claim/replay, catalog and input owners stay real.
    vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request => {
        expect(request.machineId).toBe(machineId);
        return { protocolVersion: 1, projection };
    });
    const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, board: { enabled: true } } },
        capabilities: { serverIdentity: { serverIdentityId: serverId } } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(features));
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/profile', async () => ({ id: accountId }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: { id: sessionId, seq: 1, createdAt: 1, updatedAt: 1,
        active: false, activeAt: 1, encryptionMode: 'plain', metadata: JSON.stringify({ machineId }), metadataVersion: 1,
        dataEncryptionKey: null, agentState: null, agentStateVersion: 0, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    } }));
    app.get(`/v2/sessions/${sessionId}/system-records/record`, async () => ({ record: null }));
    app.get(`/v2/sessions/${sessionId}/system-records`, async () => ({ records: [], hasNext: false, nextCursor: null }));
    const surface = { serverId, accountId, owner: { kind: 'sessionBoard' as const, sessionId } };
    const actionArgs = { surface, instance: { v: 1, id: 'approved-counter', definition: { kind: 'installed', surface: { pluginId, localId: 'counter' } },
        bindings: { filter: { kind: 'value', value: 'files' } } }, placement: { tabId: 'counts', tabTitle: 'Counts', width: 'wide' } };
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli', sessionId }, requestedSurface: 'cli', approval: { flow: 'deferred', result: 'required' },
        actionId: 'widgets.item.add', actionArgs, summary: 'Add count',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
            serverId, serverIdentityId: serverId, accountId, sessionId, machineId, target: { kind: 'machine', machineId },
            actionId: 'widgets.item.add', requestId: 'approved-counter' },
    });
    let row = { id: 'counter-approval', ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    app.get('/v1/artifacts', async () => [row]);
    app.get('/v1/artifacts/counter-approval', async () => row);
    app.get('/v1/artifacts/counter-approval/access/recipients', async () => ({ artifactId: row.id, ownerAccountId: accountId,
        access: 'owner', encryptionMode: 'plain', dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey,
        provenanceDataEncryptionKey: null, callerProvenanceDataEncryptionKey: null, recipients: [] }));
    app.get('/v1/artifacts/counter-approval/access/grants', async () => ({ artifactId: row.id, ownerAccountId: accountId, access: 'owner', grants: [] }));
    app.post('/v1/artifacts/counter-approval', async http => {
        const update = z.object({ header: z.string(), body: z.string(), expectedHeaderVersion: z.number(), expectedBodyVersion: z.number() }).parse(http.body);
        expect(update.expectedHeaderVersion).toBe(row.headerVersion);
        expect(update.expectedBodyVersion).toBe(row.bodyVersion);
        row = { ...row, ...update, headerVersion: row.headerVersion + 1, bodyVersion: row.bodyVersion + 1 };
        return { success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion };
    });
    let writes = 0;
    // The outer writer is deliberately refused at HTTP after admission, making
    // this test independent of Board layout semantics covered by its own suite.
    app.put(`/v2/sessions/${sessionId}/board`, async (_request, reply) => {
        writes++;
        return reply.code(403).send({ error: 'session_board_forbidden' });
    });
    try {
        const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId, serverId,
            serverApiUrl: 'http://widget-approval.test', resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }) });
        // The contributed-plugin endpoint does not own built-in Actions. The
        // deciding CLI has declarations but no in-process plugin registry.
        vi.spyOn(daemonControl, 'requestDaemonPluginActionExecution').mockResolvedValue({ matched: false });
        const daemon = createCliActionExecutorHarness({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'http://widget-approval.test' }, {
            ...createRegistryInputTypeDeps({ contributes: registry, readUiResource: async () => ({ resource: { pluginId, localId: 'count-kinds' },
                kind: 'config', contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
                bytes: new TextEncoder().encode(JSON.stringify([{ value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders' }])) }) }),
        });
        const { executor } = createCliActionExecutorHarness({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'http://widget-approval.test',
            // The authenticated built-in Action transport is a genuine process
            // boundary. Its receiving options owner and Resource path stay real.
            readAdmittedInputTypeOptions: async ({ input, context }) => {
                const result = await daemon.executor.execute('action.options.resolve', input, context);
                return result.ok ? result.result : result;
            },
        }, {
            isApprovalExecutionOriginCurrent: currentness,
        });
        const result = await runWithServerHttpBaseUrl('http://widget-approval.test', () => executor.execute('approval.request.decide',
            { artifactId: row.id, decision: 'approve' }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId, serverIdentityId: serverId, runtimeAccountId: accountId, actionRequestId: 'decide-counter' }));
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'session_board_forbidden' } } });
        expect(writes).toBe(1);
        const stored = decodePlainArtifactStoredContent(row.body);
        expect(stored).toHaveProperty('body');
    } finally { restore(); vi.restoreAllMocks(); await app.close(); }
});
