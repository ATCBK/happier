import { expect, it } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { MCP_SERVER_ACTION_INPUT_SCHEMAS_V1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { createMcpAlwaysAllowController } from './mcpAlwaysAllow';

it('does not claim persistence before the exact plugin-item write is acknowledged; concurrent taps share that write', async () => {
    const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'plugin-team', tool: '__proto__', item: { serverId: 'plugin:acme.team/docs',
        plugin: { pluginId: 'acme.team', localId: 'docs' } }, serverTitle: 'Team docs',
        decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
    const pending = createDeferred<{ ok: true; result: unknown }>();
    const writes: unknown[] = [];
    let answers = 0;
    const controller = createMcpAlwaysAllowController({ identity, answerForSession: async () => { answers++; },
        execute: async (actionId, input) => { writes.push(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input)); return pending.promise; } });
    const first = controller.allow(); const second = controller.allow();
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ status: 'saving', answered: true });
    expect(writes).toEqual([{ serverId: 'plugin:acme.team/docs', tools: JSON.parse('{"__proto__":"allow"}') }]);
    pending.resolve({ ok: true, result: MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.set'].parse({ revision: 2, previous: { tools: { ['__proto__']: 'inherit' } } }) });
    await first; await second;
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved' });
    expect(answers).toBe(1); expect(writes).toHaveLength(1);
});

it('never writes a persistent setting after a failed permission answer', async () => {
    const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'github', tool: 'delete_file', item: { serverId: 'github' }, serverTitle: 'GitHub',
        decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
    let writes = 0;
    const controller = createMcpAlwaysAllowController({ identity, answerForSession: async () => { throw new Error('Offline'); },
        execute: async () => { writes++; return { ok: false, error: 'must_not_write', errorCode: 'must_not_write' }; } });
    await controller.allow();
    expect(controller.getSnapshot()).toMatchObject({ status: 'answer_failed', answered: false });
    expect(writes).toBe(0);
});

it('retries only the catalog save after a conflict or malformed success, and excludes the built-in server', async () => {
    const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'github', tool: 'delete_file', item: { serverId: 'github' }, serverTitle: 'GitHub',
        decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
    let answers = 0;
    const receipts = [
        { ok: false as const, errorCode: 'mcp_catalog_conflict', error: 'mcp_catalog_conflict' },
        { ok: true as const, result: { status: 'updated', revision: 2 } },
        { ok: true as const, result: MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.set'].parse({ revision: 2, previous: { tools: { delete_file: 'inherit' } } }) },
    ];
    const controller = createMcpAlwaysAllowController({ identity, answerForSession: async () => { answers++; },
        execute: async () => receipts.shift()! });
    await controller.allow();
    expect(controller.getSnapshot()).toMatchObject({ status: 'save_failed', answered: true, errorCode: 'mcp_catalog_conflict' });
    await controller.allow();
    expect(controller.getSnapshot()).toMatchObject({ status: 'save_failed', errorCode: 'invalid_action_output' });
    await controller.allow();
    expect(controller.getSnapshot().status).toBe('saved');
    expect(answers).toBe(1);
    const builtIn = createMcpAlwaysAllowController({ identity: { ...identity, server: 'happier' },
        answerForSession: async () => { throw new Error('Must not answer'); }, execute: async () => { throw new Error('Must not write'); } });
    await expect(builtIn.allow()).rejects.toThrow('mcp_always_allow_unavailable');
    expect(builtIn.getSnapshot().status).toBe('idle');
});
