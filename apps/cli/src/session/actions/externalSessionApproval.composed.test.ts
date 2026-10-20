import fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { SessionLookupByTagsResponseV2Schema, V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { configuration } from '@/configuration';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';

afterEach(() => vi.restoreAllMocks());

it.each(['policy', 'explicit', 'cli'] as const)('replays a %s native link approval on its Machine without resolving cli-global as a Session', async mode => {
    const app = fastify();
    const endpoint = 'http://native-approval.test';
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    const serverId = configuration.activeServerId;
    const homeId = 'srv_native_approval';
    const machineId = 'native-machine';
    const accountId = 'native-owner';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    const features = registerAccountHomeHttp(app, { accountId, serverId: homeId });
    // A mistaken contextual-Session lookup sees a valid empty inventory, as on
    // the real Home, rather than failing on a missing HTTP fixture route.
    app.post('/v2/sessions/lookup-by-tags', async () => SessionLookupByTagsResponseV2Schema.parse({ sessions: [] }));
    const emptySessions = V2SessionListResponseSchema.parse({ sessions: [], hasNext: false, nextCursor: null });
    app.get('/v2/sessions', async () => emptySessions);
    app.get('/v2/sessions/archived', async () => emptySessions);
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
    const effects: unknown[] = [];
    // HTTP storage/features and the final Machine RPC are system boundaries.
    // MCP, catalog, approval construction/claim/currentness and replay stay real.
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        expect(request.machineId).toBe(machineId);
        effects.push(request.request);
        return { ok: true, sessionId: 'linked-native-session', created: true };
    });
    const { mcp } = runWithServerHttpBaseUrl(endpoint, () => createExternalMcpServer({ credentials,
        machineId, daemonControlTarget: null,
        serverFeaturesSnapshot: { status: 'ready', provenance: 'authenticated', features } }));
    const client = new Client({ name: 'native-approval', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const input = { machineId, agentId: 'claude', remoteSessionId: 'native-fixture',
        source: { kind: 'claudeConfig', projectId: '-tmp' } };
    const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId,
        serverId, serverApiUrl: endpoint });
    const { executor } = createCliActionExecutorHarness({ token: credentials.token, credentials,
        sessionId: 'cli-global', mode: 'plain', ctx: null, serverId, serverIdentityId: homeId,
        serverHttpBaseUrl: endpoint }, { isApprovalExecutionOriginCurrent: currentness });
    try {
        const response = mode === 'cli' ? null : CallToolResultSchema.parse(await client.callTool({ name: mode === 'policy' ? 'sessions_external_link_ensure' : 'approval_request_create',
            arguments: mode === 'policy' ? input : { actionId: 'sessions.external.link.ensure', actionArgs: input,
                summary: 'Link native fixture', createdBy: { surface: 'mcp' } } }));
        const content = response?.content.find(item => item.type === 'text');
        const cli = mode === 'cli' ? await runWithServerHttpBaseUrl(endpoint, () => executor.execute('sessions.external.link.ensure', input,
            { surface: 'cli', authority: 'present_user', defaultSessionId: 'cli-global', defaultSessionMachineId: machineId,
                serverId, serverIdentityId: homeId, actionRequestId: 'cli-native-link' })) : null;
        const result = cli ? cli.ok ? cli.result : cli : JSON.parse(content?.type === 'text' ? content.text : '{}');
        expect(result).toMatchObject({ artifactId: expect.any(String) });
        expect(effects).toEqual([]);
        const readRequest = () => {
            const body = decodePlainArtifactStoredContent(artifacts.read(result.artifactId)!.body);
            if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Missing approval body');
            return ApprovalRequestV2Schema.parse(JSON.parse(body.body));
        };
        expect(readRequest()).toMatchObject({ status: 'open', actionArgs: input,
            executionOriginV1: { machineId, sessionId: 'cli-global', surface: mode === 'cli' ? 'cli' : 'mcp' } });
        const decided = await runWithServerHttpBaseUrl(endpoint, () => executor.execute('approval.request.decide',
            { artifactId: result.artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user',
                serverId, serverIdentityId: homeId, runtimeAccountId: accountId }));
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        expect(effects).toEqual([input]);
        expect(readRequest().status).toBe('executed');
    } finally {
        await client.close(); await mcp.close(); restore(); await app.close();
    }
});
