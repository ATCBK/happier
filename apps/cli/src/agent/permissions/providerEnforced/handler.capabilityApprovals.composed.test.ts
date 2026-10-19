// Reuse the UI harness's native SDK boundaries for this real UI→CLI composition.
import '../../../../../ui/sources/dev/vitestSetup';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { listPendingPermissionRequests } from '@happier-dev/session-core/pending';
import { createMcpServerActionExecuteV1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { McpServerCatalogV1Schema, McpServerCatalogRowReadResponseV1Schema, McpServerCatalogRowMutationResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveReachV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { SessionCapabilitiesSetInputV1Schema, SessionCapabilitiesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { ServerBoundPermissionRpcHandlerManager } from '../testkit/serverBoundPermissionRpcHandlerManager';
import { ProviderEnforcedPermissionHandler } from './handler';
import { createMcpAlwaysAllowController } from '../../../../../ui/sources/components/tools/shell/permissions/mcpAlwaysAllow';
import { answerSessionPermission } from '../../../../../ui/sources/sync/ops/sessionPermissionAnswers';
import { buildPermissionPromptModel } from '../../../../../ui/sources/components/tools/shell/permissions/presentation/buildPermissionPromptModel';
import { readCapabilityEnableApproval, resolveCapabilityAlwaysWrite, createCapabilityEnableApprovalController } from '../../../../../ui/sources/components/sessions/capabilities/capabilityEnableApproval';
import { useReachRulesState } from '../../../../../ui/sources/sync/domains/capabilities/reach/useReachRulesState';
import { renderHook, act } from '../../../../../ui/sources/dev/testkit';

afterEach(() => vi.restoreAllMocks());
const presentUser = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' } as const;

async function fixture() {
    // Persistence, HTTP and authenticated permission RPC are real in-process boundaries.
    // No catalog, Action, approval policy or permission decision is mocked.
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE rows (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, content TEXT NOT NULL)');
    const initial = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'github-id', name: 'github', title: 'GitHub', transport: 'http',
        remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1,
        tools: { default: 'allow_read_only', overrides: {} }, toolsSnapshot: { checkedAt: 1, machineId: 'machine',
            tools: [{ name: 'delete_file', title: 'Delete file', annotations: { destructiveHint: true }, tokens: 8 }] } }],
        bindings: [{ id: 'except-agent', serverId: 'github-id', target: { t: 'allMachines' }, agentId: 'gemini', enabled: false, createdAt: 1, updatedAt: 1 }] });
    db.prepare('INSERT INTO rows VALUES (?, ?, ?)').run('mcp', 1, JSON.stringify(initial));
    db.prepare('INSERT INTO rows VALUES (?, ?, ?)').run('session', 1, '{}');
    const read = (id: string) => {
        const row = db.prepare('SELECT revision, content FROM rows WHERE id = ?').get(id);
        if (!row) throw new Error('Missing row');
        return { revision: Number(row.revision), content: JSON.parse(String(row.content)) as unknown };
    };
    const catalog = () => McpServerCatalogV1Schema.parse(read('mcp').content);
    let failWrite = false;
    const home = createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        const id = request.url?.slice(1) ?? '';
        if (request.method === 'GET') {
            const row = read(id);
            response.end(JSON.stringify(McpServerCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: row.revision,
                content: { t: 'plain', v: row.content } })));
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { expectedRevision: number; catalog: unknown };
        const parsed = McpServerCatalogV1Schema.parse(body.catalog);
        const update = failWrite ? { changes: 0 } : db.prepare('UPDATE rows SET revision = revision + 1, content = ? WHERE id = ? AND revision = ?')
            .run(JSON.stringify(parsed), id, body.expectedRevision);
        response.end(JSON.stringify(McpServerCatalogRowMutationResponseV1Schema.parse(update.changes
            ? { status: 'updated', revision: body.expectedRevision + 1, cursor: body.expectedRevision + 1 }
            : { status: 'conflict', revision: read(id).revision })));
    });
    const socketHome = new Server(home);
    const session = createMutableApiSessionClientFixture({ sessionId: 'session' });
    const rpc = new ServerBoundPermissionRpcHandlerManager(session.sessionId);
    vi.spyOn(session.rpcHandlerManager, 'registerHandler').mockImplementation((name, handler) => rpc.registerHandler(name, handler));
    socketHome.use((socket, next) => socket.handshake.auth.token === 'owner-fixture' ? next() : next(new Error('Unauthorized')));
    socketHome.on('connection', socket => socket.on('permission', async (payload, ack) => {
        const handler = rpc.handlers.get('session.permission.respond');
        if (!handler) { ack({ error: 'unregistered' }); return; }
        try { const result = await handler(payload); ack(result === undefined ? { ok: true } : result); }
        catch { ack({ error: 'permission-refused' }); }
    }));
    home.listen(0, '127.0.0.1'); await once(home, 'listening');
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const url = `http://127.0.0.1:${address.port}`;
    const socket = io(url, { auth: { token: 'owner-fixture' } });
    await once(socket, 'connect');
    const port = createMcpServerActionExecuteV1({
        readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
            readRow: async () => McpServerCatalogRowReadResponseV1Schema.parse(await (await fetch(`${url}/mcp`)).json()) }),
        mutate: async (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog: catalog(), revision: Number(expectedRevision), change, scope: null,
            ctx: { nowMs: 2, newId: () => 'project-agent' }, writeCatalog: async value => McpServerCatalogRowMutationResponseV1Schema.parse(await (await fetch(`${url}/mcp`, {
                method: 'POST', body: JSON.stringify(value), headers: { 'content-type': 'application/json' },
            })).json()) }),
        machine: async () => { throw new Error('Account writes do not need a Machine'); },
    });
    const approvals: ApprovalRequest[] = [];
    const deps = { mcpServerAction: port,
        sessionCapabilities: {
            readSession: async () => ({ metadata: read('session').content as object, revision: read('session').revision,
                sessionRunning: true, agent: { vendorResume: 'supported', skillsLiveReload: 'supported' }, launchRestart: 'automatic' }),
            resolveItem: async ({ id }) => catalog().servers.some(server => server.id === id) ? id : null,
            writeMetadata: async ({ update }) => {
                const current = read('session');
                return db.prepare('UPDATE rows SET content = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
                    .run(JSON.stringify(update(current.content as object)), 'session', current.revision).changes ? 'updated' : 'conflict';
            },
        },
        approvalsCreate: async ({ request }) => {
            const parsed = ApprovalRequestSchema.parse(request);
            db.prepare('INSERT INTO rows VALUES (?, ?, ?)').run('approval', 1, JSON.stringify(parsed));
            approvals.push(parsed); return { artifactId: 'approval' };
        },
        approvalsGet: async () => ApprovalRequestSchema.parse(read('approval').content),
        approvalsUpdate: async ({ request }) => {
            const current = read('approval');
            const next = ApprovalRequestSchema.parse(request);
            const transition = decideApprovalRequestTransition(ApprovalRequestSchema.parse(current.content), next);
            if (!transition.ok) return transition;
            const result = db.prepare('UPDATE rows SET content = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
                .run(JSON.stringify(next), 'approval', current.revision);
            return result.changes ? { ok: true } : { ok: false, errorCode: 'conflict', error: 'conflict' };
        },
        // Home currentness is an authenticated transport boundary; the replay
        // and immutable origin/Artifact transition owners above remain real.
        isApprovalExecutionOriginCurrent: async ({ origin, request }) => origin.serverId === 'home'
            && origin.actionId === 'session.capabilities.set' && origin.requestId === 'enable'
            && SessionCapabilitiesSetInputV1Schema.parse(request.actionArgs).sessionId === 'session',
    } satisfies Pick<ActionExecutorDeps, 'mcpServerAction' | 'sessionCapabilities' | 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate' | 'isApprovalExecutionOriginCurrent'>;
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
    const permission = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[capability approval]', getWorkspaceWrites: () => 'allow',
        getMcpToolContext: () => ({ catalog: { status: 'ready', authority: 'active', revision: read('mcp').revision, diagnostics: [], catalog: catalog() },
            mcpServerIdentities: { github: { serverId: 'github-id', serverTitle: 'GitHub' } } }) });
    return { session, permission, executor, approvals, catalog, metadata: () => read('session').content,
        readApproval: () => ApprovalRequestSchema.parse(read('approval').content),
        setFailWrite(value: boolean) { failWrite = value; },
        async respond(params: unknown) {
            const receipt: unknown = await socket.emitWithAck('permission', params);
            if (!receipt || typeof receipt !== 'object' || !('ok' in receipt)) throw new Error('Permission response failed');
        },
        async close() { await permission.reset(); socket.disconnect(); await new Promise<void>(resolve => socketHome.close(() => resolve())); db.close(); },
    };
}

it('Always allow crosses the real permission projection, answer RPC, public Action and catalog CAS; retry only saves', async () => {
    const f = await fixture();
    try {
        const pending = f.permission.handleToolCall('delete', 'mcp__github__delete_file', { file_path: 'src/index.ts' });
        // Cleanup can cancel a still-pending request after a failed assertion; retain
        // the original promise for deciding assertions without leaking that rejection.
        void pending.catch(() => undefined);
        const state = AgentStateSchema.parse(f.session.__getAgentState());
        expect(state.requests?.delete).toHaveProperty('mcpTool.item.serverId', 'github-id');
        const request = listPendingPermissionRequests({ sessionId: 'session', active: true, agentState: state, actionConfirmations: null,
            presentationCompletedRequests: null, projected: null })[0]!;
        const settings = await f.executor.execute('mcp.servers.tools.list', { serverId: 'github-id' }, presentUser);
        if (!settings.ok) throw new Error('Cannot read server default');
        const tools = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(settings.result);
        const model = buildPermissionPromptModel({ request, metadata: null, nowMs: 1, serverDefault: tools.settings.default });
        expect(model.mcp).toMatchObject({ serverId: 'github-id', toolName: 'delete_file', badges: ['destructive'] });
        expect(model.headerText.title).toBe('Delete file · GitHub');
        if (!model.mcp) throw new Error('Missing real MCP identity');
        let answers = 0;
        const controller = createMcpAlwaysAllowController({ identity: request.mcpTool!,
            answerForSession: async () => { answers++; await answerSessionPermission({ requestId: request.id, toolName: request.tool,
                answer: 'allowForSession', policy: { protocol: 'codexDecision', usePermissionUpdates: false }, respondToPermission: f.respond }); },
            execute: (id, input) => f.executor.execute(id, input, presentUser) });
        f.setFailWrite(true);
        await controller.allow();
        await expect(pending).resolves.toMatchObject({ decision: 'approved_for_session' });
        expect(controller.getSnapshot()).toMatchObject({ status: 'save_failed', answered: true });
        expect(f.catalog().servers[0]?.tools?.overrides.delete_file).toBeUndefined();
        f.setFailWrite(false);
        await controller.allow();
        expect(answers).toBe(1);
        expect(controller.getSnapshot()).toMatchObject({ status: 'saved' });
        const listed = await f.executor.execute('mcp.servers.tools.list', { serverId: 'github-id' }, presentUser);
        if (!listed.ok) throw new Error('List failed');
        expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(listed.result).tools[0]).toMatchObject({ setting: 'allow', source: 'tool' });
        expect(f.approvals).toEqual([]);
        await expect(f.permission.handleToolCall('again', 'mcp__github__delete_file', {})).resolves.toMatchObject({ decision: 'approved' });
    } finally { await f.close(); }
});

it('Agent enable uses the existing request with reason and Always preserves the excepted Agent at the project', async () => {
    const f = await fixture();
    try {
        const input = { sessionId: 'session', kind: 'mcp_server', id: 'github-id', state: 'on', reason: 'Read issue context' };
        const requested = await f.executor.execute('session.capabilities.set', input, { surface: 'agent', authority: 'account_automation',
            defaultSessionId: 'session', defaultSessionMachineId: 'machine', serverId: 'home', actionRequestId: 'enable', actionCaller: { kind: 'host' } });
        expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        expect(readSessionCapabilitySelectionFromMetadataV1(f.metadata()).mcp.forceIncludeServerIds).toEqual([]);
        const approval = f.approvals[0]!;
        expect(readCapabilityEnableApproval(approval)).toMatchObject({ reason: 'Read issue context', id: 'github-id' });
        const rules = f.catalog().bindings;
        const decidedBy = resolveReachV1(rules, { agentId: 'gemini', machineId: 'machine', projectKey: 'project', machinePlatform: 'posix', directory: '/repo' }).decidedBy;
        const write = resolveCapabilityAlwaysWrite({ decidedBy, rules, projectKey: 'project', machineId: 'machine' });
        expect(write).toEqual({ place: { t: 'project', projectKey: 'project' }, agentId: 'gemini', state: 'on' });
        if (!write) throw new Error('No Always scope');
        let replayResult: unknown;
        const reach = await renderHook(() => useReachRulesState({ key: 'home:account:github', kind: 'mcp_server', itemId: 'github-id',
            rules: rules.map(({ serverId: _serverId, ...rule }) => rule), revision: 1, status: 'ready', valueAvailable: true },
            (id, input) => f.executor.execute(id, input, presentUser)));
        let decisions = 0;
        const controller = createCapabilityEnableApprovalController({ alwaysWrite: write,
            decide: async decision => {
                decisions++;
                const result = await f.executor.execute('approval.request.decide', { artifactId: 'approval', decision }, presentUser);
                replayResult = result;
                const stored = f.readApproval();
                return result.ok && (decision === 'reject' ? stored.status === 'rejected'
                    : stored.status === 'executed' && stored.execution?.ok === true && SessionCapabilitiesSetOutputV1Schema.parse(stored.execution.result).ok);
            }, changeRules: change => reach.getCurrent().change(change), undoRules: () => reach.getCurrent().undoLast() });
        f.setFailWrite(true);
        await act(async () => { await controller.choose('always'); });
        expect(controller.getSnapshot(), JSON.stringify({ replayResult, approval: f.readApproval() }))
            .toMatchObject({ status: 'always_failed', approved: true });
        expect(readSessionCapabilitySelectionFromMetadataV1(f.metadata()).mcp.forceIncludeServerIds).toEqual(['github-id']);
        expect(resolveReachV1(f.catalog().bindings, { agentId: 'gemini', machineId: 'machine', projectKey: 'project', machinePlatform: 'posix', directory: '/repo' }).enabled).toBe(false);
        f.setFailWrite(false);
        await act(async () => { await controller.choose('always'); });
        expect(decisions).toBe(1);
        expect(replayResult, JSON.stringify(f.readApproval())).toMatchObject({ ok: true });
        expect(controller.getSnapshot(), JSON.stringify(replayResult)).toMatchObject({ status: 'always_saved' });
        expect(readSessionCapabilitySelectionFromMetadataV1(f.metadata()).mcp.forceIncludeServerIds).toEqual(['github-id']);
        expect(resolveReachV1(f.catalog().bindings, { agentId: 'gemini', machineId: 'machine', projectKey: 'project', machinePlatform: 'posix', directory: '/repo' }).enabled).toBe(true);
        expect(resolveReachV1(f.catalog().bindings, { agentId: 'gemini', machineId: 'machine', projectKey: 'elsewhere', machinePlatform: 'posix', directory: '/repo' }).enabled).toBe(false);
        expect(f.approvals).toHaveLength(1);
        await act(async () => { await controller.undoAlways(); });
        expect(resolveReachV1(f.catalog().bindings, { agentId: 'gemini', machineId: 'machine', projectKey: 'project', machinePlatform: 'posix', directory: '/repo' }).enabled).toBe(false);
        expect(controller.getSnapshot().status).toBe('session_allowed');
        await reach.unmount();
    } finally { await f.close(); }
});
