import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, buildApprovalRequestArtifactHeaderV1, buildHomeHubArtifactIdV1, encodePlainArtifactStoredContent, decodePlainArtifactStoredContent, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { createRegistryInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import * as daemonControl from '@/daemon/controlClient';
import { createCounterWidgetFixture, registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';

it('replays approved installed Board inputs on the hosting Session without an ambient CLI Session', async () => {
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://widget-approval.test' });
    const accountId = 'widget-owner';
    const serverId = 'srv_widget_approval';
    const machineId = 'counter-machine';
    const sessionId = 'c000000000000000000000066';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const { pluginId, projection, registry, readUiResource } = createCounterWidgetFixture();
    // Only Home HTTP, Machine RPC and the plugin Resource transport are replaced.
    // The CLI composition, approval claim/replay, catalog and input owners stay real.
    vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request => {
        expect(request.machineId).toBe(machineId);
        return { protocolVersion: 1, projection };
    });
    const features = registerAccountHomeHttp(app, { accountId, serverId });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(features));
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
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    artifacts.seed('counter-approval', encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
        encodePlainArtifactStoredContent({ body: JSON.stringify(request) }));
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
            ...createRegistryInputTypeDeps({ contributes: registry, readUiResource }),
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
            { artifactId: 'counter-approval', decision: 'approve' }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId, serverIdentityId: serverId, runtimeAccountId: accountId, actionRequestId: 'decide-counter' }));
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'session_board_forbidden' } } });
        expect(writes).toBe(1);
        const stored = decodePlainArtifactStoredContent(artifacts.read('counter-approval')!.body);
        expect(stored).toHaveProperty('body');
    } finally { restore(); vi.restoreAllMocks(); await app.close(); }
});

it('replays an approved installed widget add on Home, an Account surface with no hosting Session or ambient CLI Machine', async () => {
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://widget-approval.test' });
    const accountId = 'widget-owner';
    const serverId = 'srv_widget_approval';
    const machineId = 'counter-machine';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const { definition, projection, registry, readUiResource } = createCounterWidgetFixture();
    // Only Home HTTP, Machine RPC and the plugin Resource transport are replaced.
    vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request => {
        expect(request.machineId).toBe(machineId);
        return { protocolVersion: 1, projection };
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(registerAccountHomeHttp(app, { accountId, serverId })));
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    // The Account's reachable daemon is the only Machine this CLI can learn of: it has no Session and no daemon of its own.
    app.get('/v1/machines', async () => [{ id: machineId, kind: 'persistent', active: true, activeAt: Date.now(), revokedAt: null, replacedByMachineId: null }]);
    const surface = { serverId, accountId, owner: { kind: 'home' as const } };
    const instance = { v: 1, id: 'home-counter', definition, bindings: { filter: { kind: 'value', value: 'files' } } };
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli', approval: { flow: 'deferred', result: 'required' },
        actionId: 'widgets.item.add', actionArgs: { surface, instance }, summary: 'Add count',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
            serverId, serverIdentityId: serverId, accountId, machineId, target: { kind: 'machine', machineId },
            actionId: 'widgets.item.add', requestId: 'approved-home-counter' },
    });
    artifacts.seed('home-approval', encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
        encodePlainArtifactStoredContent({ body: JSON.stringify(request) }));
    try {
        const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId, serverId,
            serverApiUrl: 'http://widget-approval.test', resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }) });
        vi.spyOn(daemonControl, 'requestDaemonPluginActionExecution').mockResolvedValue({ matched: false });
        const daemon = createCliActionExecutorHarness({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'http://widget-approval.test' }, {
            ...createRegistryInputTypeDeps({ contributes: registry, readUiResource }),
        });
        const { executor } = createCliActionExecutorHarness({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'http://widget-approval.test',
            readAdmittedInputTypeOptions: async ({ input, context }) => {
                const result = await daemon.executor.execute('action.options.resolve', input, context);
                return result.ok ? result.result : result;
            },
        }, { isApprovalExecutionOriginCurrent: currentness });
        const result = await runWithServerHttpBaseUrl('http://widget-approval.test', () => executor.execute('approval.request.decide',
            { artifactId: 'home-approval', decision: 'approve' }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId, serverIdentityId: serverId, runtimeAccountId: accountId, actionRequestId: 'decide-home-counter' }));
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        const home = artifacts.read(buildHomeHubArtifactIdV1(accountId));
        expect(decodePlainArtifactStoredContent(home!.body)).toMatchObject({ body: expect.stringContaining('home-counter') });
    } finally { restore(); vi.restoreAllMocks(); await app.close(); }
});
