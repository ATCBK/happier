import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveMcpToolDecisionV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';
import type { AgentContribution } from '../agents.js';
import type { AgentSessionRuntime, AgentSessionOpenRequest } from '../agentRuntime/session.js';
import { createAgentLaunchObserver, type AgentLaunchObserverBoundaries } from './observeAgentLaunch.js';
import { runAgentMcpToolPolicyContract, type AgentMcpToolPolicyContractInput,
    type AgentMcpToolPolicyCallObservation, type AgentMcpToolPolicyPermissionObservation } from './mcpToolPolicyContract.js';

// This fake Agent is the kit's test subject, not a stand-in for a first-party leaf.
// Its server receives actual HTTP calls; the same strict request/result schemas
// validate producer output and the fixture consumer.
const requestSchema = z.object({ server: z.string(), tool: z.string() }).strict();
const responseSchema = z.object({ ok: z.literal(true) }).strict();
const agent = { id: 'mcp-kit-fixture', title: 'Kit fixture', primary: 'sessions', runtime: { kind: 'custom' },
    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
        tools: { delivery: 'native_mcp' } } } satisfies AgentContribution;

function harness(native: boolean): AgentMcpToolPolicyContractInput {
    let server: Server;
    let url: string;
    let order = 0;
    let mode: NonNullable<AgentSessionOpenRequest['configuration']>['permissionIntent']['value'] = 'default';
    let settings: Readonly<Record<string, 'off' | 'ask' | 'allow'>> = {};
    let calls: AgentMcpToolPolicyCallObservation[] = [];
    let observer: ReturnType<typeof createAgentLaunchObserver>;
    let boundaries: AgentLaunchObserverBoundaries;
    const state = new WeakMap<AgentSessionRuntime, { request: AgentSessionOpenRequest; grants: Set<string> }>();
    const controls = { off: native ? 'hidden' : 'blocked', approval: native ? 'native' : 'host' } as const;
    return {
        agent: { ...agent, id: native ? 'mcp-kit-native-fixture' : agent.id }, candidateControl: controls,
        fixtureServer: {
            async prepare({ cwd }) {
                order = 0; calls = [];
                observer = createAgentLaunchObserver({ home: cwd });
                boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
                server = createServer(async (request, response) => {
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) chunks.push(Buffer.from(chunk));
                    const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
                    calls.push({ ...input, order: ++order });
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify(responseSchema.parse({ ok: true })));
                });
                await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
                const address = server.address();
                if (!address || typeof address === 'string') throw new Error('No fixture address');
                url = `http://127.0.0.1:${address.port}`;
                return { servers: [
                    { key: 'server__a', serverId: 'catalog:a', title: 'Same title', tool: 'read', config: { command: 'fixture', args: [url] } },
                    { key: 'server-b', serverId: 'catalog:b', title: 'Same title', tool: 'read', config: { command: 'fixture', args: [url] } },
                ], secrets: ['fixture-secret-never-in-agent-ambient-state'] };
            },
            observeCalls: () => calls,
            async setPolicy(input) {
                mode = input.permissionMode; settings = input.settings;
                if (native && input.runtime) await input.runtime.updateConfiguration!({ ...input.configuration, mcpToolPolicy: input.projection });
            },
            async dispose() { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
        },
        async openSession(request) {
            boundaries.recordLaunch({ argv: ['fixture', url], env: {} });
            boundaries.recordAppServerRequest('configuration', request.mcpToolPolicy);
            const runtime: AgentSessionRuntime = {
                async send() { return { status: 'admitted' }; },
                async updateConfiguration(update) {
                    request = { ...request, configuration: update, mcpToolPolicy: update.mcpToolPolicy };
                    state.get(runtime)!.request = request;
                    boundaries.recordAppServerRequest('configuration', update.mcpToolPolicy);
                    return { status: 'applied', changed: ['mcpToolPolicy'] };
                },
                watch() { return { dispose() {} }; }, async dispose() {},
            };
            state.set(runtime, { request, grants: new Set() });
            return runtime;
        },
        observeLaunch: () => observer.observeLaunch(),
        async observeNativePolicy(runtime) {
            const policy = state.get(runtime)!.request.mcpToolPolicy ?? {};
            return { policy, artifacts: [{ source: 'request', key: 'configuration', value: JSON.stringify(policy) }] };
        },
        async observeToolShell() {
            // Real OS child boundary, so this can detect inherited environment leaks.
            const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({argv:process.argv,env:process.env}))'], {
                env: { HAPPIER_FIXTURE_PARENT: 'synthetic-parent-environment' }, stdio: ['ignore', 'pipe', 'pipe'],
            });
            const chunks: Buffer[] = [];
            child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
            await new Promise<void>((resolve, reject) => {
                child.once('error', reject);
                child.once('close', code => code === 0 ? resolve() : reject(new Error(`Shell fixture exit ${code}`)));
            });
            return z.object({ argv: z.array(z.string()), env: z.record(z.string(), z.string()) }).strict().parse(JSON.parse(Buffer.concat(chunks).toString()));
        },
        async invokeTool(runtime, request) {
            const session = state.get(runtime)!;
            const decision = resolveMcpToolDecisionV1({ policy: { default: 'ask', overrides: { [request.tool]: settings[request.server] ?? 'ask' } },
                toolName: request.tool, permissionMode: mode ?? 'default' });
            if (native && session.request.mcpToolPolicy?.[request.server]?.tools[request.tool] === 'off') return { outcome: 'hidden', permissions: [] };
            const denied = decision.approval === 'deny';
            const grantKey = `${request.server}/${request.tool}`;
            const nativeAllow = native && session.request.mcpToolPolicy?.[request.server]?.tools[request.tool] === 'allow';
            const permissions: AgentMcpToolPolicyPermissionObservation[] = nativeAllow ? [] : [{
                server: request.server, serverId: request.server === 'server__a' ? 'catalog:a' : 'catalog:b', tool: request.tool,
                decision: denied ? 'denied' : 'approved', prompted: !denied && decision.approval === 'ask' && !session.grants.has(grantKey), order: ++order,
            }];
            if (denied) return { outcome: 'denied', permissions };
            if (request.approvalScope === 'session') session.grants.add(grantKey);
            const result = await fetch(url, { method: 'POST', body: JSON.stringify(requestSchema.parse({ server: request.server, tool: request.tool })) });
            responseSchema.parse(await result.json());
            return { outcome: 'completed', permissions };
        },
    };
}

runAgentMcpToolPolicyContract(harness(false));
runAgentMcpToolPolicyContract(harness(true));
