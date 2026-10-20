import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { z } from 'zod/mini';
import { assertMcpToolPolicyInvocation, assertMcpToolPolicySecrets, runAgentMcpToolPolicyContract, type AgentMcpToolPolicyCallObservation, type AgentMcpToolPolicyInvocation } from './mcpToolPolicyContract.js';

const permission = { server: 'server__a', serverId: 'catalog:a', tool: 'read', decision: 'approved', prompted: true, order: 1 } as const;
const call = { server: 'server__a', tool: 'read', order: 2 } as const;
const check = (invocation: AgentMcpToolPolicyInvocation, calls: readonly AgentMcpToolPolicyCallObservation[] = [call], expected: 'ask' | 'allow' | 'off' | 'deny' = 'ask', requireHidden = false, requireHostDenial = false) =>
    assertMcpToolPolicyInvocation({ expected, control: { off: 'hidden', approval: 'host' }, server: 'server__a', serverId: 'catalog:a', tool: 'read', invocation, calls, requireHidden, requireHostDenial });

describe('MCP contract evidence sensitivity', () => {
    it('rejects an inherited selected-secret marker observed in an actual OS child', async () => {
        const secret = 'inherited-machine-secret-marker';
        const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({env:process.env}))'], {
            env: { HAPPIER_FIXTURE_PARENT: 'synthetic-parent-environment', SELECTED_MACHINE_KEY: secret }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks: Buffer[] = [];
        child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
        await new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', code => code === 0 ? resolve() : reject(new Error(`Environment fixture exit ${code}`)));
        });
        const observed = z.strictObject({ env: z.record(z.string(), z.string()) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
        expect(() => assertMcpToolPolicySecrets([secret], [observed])).toThrow();
    });
    it('detects secrets in full inherited environment, events and escaped native config', () => {
        const secret = 'fixture-quote"and\nnewline';
        assertMcpToolPolicySecrets([secret], [{ env: { PATH: '/bin' } }]);
        expect(() => assertMcpToolPolicySecrets([secret], [{ env: { SELECTED_MACHINE_KEY: secret } }])).toThrow();
        expect(() => assertMcpToolPolicySecrets([secret], [{ runtimeEvents: [{ toolOutput: secret }] }])).toThrow();
        expect(() => assertMcpToolPolicySecrets([secret], [JSON.stringify({ nativeEnv: { KEY: secret } })])).toThrow();
    });
    it('rejects a missing, late or misidentified host boundary even when the tool completes', () => {
        check({ outcome: 'completed', permissions: [permission] });
        expect(() => check({ outcome: 'completed', permissions: [] })).toThrow();
        expect(() => check({ outcome: 'completed', permissions: [{ ...permission, order: 3 }] })).toThrow();
        expect(() => check({ outcome: 'completed', permissions: [{ ...permission, serverId: 'catalog:b' }] })).toThrow();
        expect(() => check({ outcome: 'completed', permissions: [permission] }, [{ ...call, server: 'server-b' }])).toThrow();
    });
    it('rejects native hidden claims backed only by a denied call and blocked claims without host denial', () => {
        expect(() => check({ outcome: 'denied', permissions: [] }, [], 'off', true)).toThrow();
        expect(() => check({ outcome: 'denied', permissions: [] }, [], 'off', false, true)).toThrow();
        check({ outcome: 'denied', permissions: [] }, [], 'off');
        check({ outcome: 'hidden', permissions: [] }, [], 'off', true);
        check({ outcome: 'denied', permissions: [{ ...permission, decision: 'denied', prompted: false }] }, [], 'off');
    });
    it('rejects Off receipt and Allow prompting rather than accepting the returned outcome alone', () => {
        expect(() => check({ outcome: 'denied', permissions: [{ ...permission, decision: 'denied' }] }, [call], 'off')).toThrow();
        expect(() => check({ outcome: 'completed', permissions: [permission] }, [call], 'allow')).toThrow();
        check({ outcome: 'completed', permissions: [{ ...permission, prompted: false }] }, [call], 'allow');
        expect(() => assertMcpToolPolicyInvocation({ expected: 'allow', control: { off: 'hidden', approval: 'native' },
            server: 'server__a', serverId: 'catalog:a', tool: 'read', calls: [call],
            invocation: { outcome: 'completed', permissions: [{ ...permission, prompted: false, decision: 'denied' }] } })).toThrow();
    });
});

// The fake Agent is the contract's self-test subject. Register its suite through
// the real runner so ordinary barrel admission cannot make these helpers inert.
runAgentMcpToolPolicyContract({
    agent: {
        id: 'runner-fixture', title: 'Runner fixture', primary: 'sessions', runtime: { kind: 'custom' },
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
    },
    async openSession() {
        return {
            async send() { return { status: 'admitted' }; },
            async cancel() { return { status: 'notRunning' }; },
            async updateConfiguration() { return { status: 'applied', changed: [] }; },
            watch() { return { dispose() {} }; },
            async dispose() {},
        };
    },
    observeLaunch: () => ({ argv: [], env: {}, acpSessionNew: null, appServerRequests: [], filesWritten: [], runtimeEvents: [] }),
    async invokeTool() { throw new Error('The unsupported Agent cannot invoke MCP tools.'); },
    fixtureServer: {
        async prepare() {
            return { servers: [
                { key: 'a', serverId: 'server-a', title: 'Duplicate', tool: 'read', config: { command: 'fixture' } },
                { key: 'b', serverId: 'server-b', title: 'Duplicate', tool: 'read', config: { command: 'fixture' } },
            ], secrets: [] };
        },
        observeCalls: () => [],
        async setPolicy() {},
        async dispose() {},
    },
});
