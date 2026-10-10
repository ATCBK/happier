import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { AccountSettingsSchema, ActionIdSchema, normalizeActionsSettingsV1, RPC_METHODS, type ActionId } from '@happier-dev/protocol';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

const policy = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: {
    'machines.replacement.set': ['cli', 'agent', 'mcp'],
    'machines.replacement.clear': ['cli', 'agent', 'mcp'],
    'machines.daemon.stop': ['cli', 'agent', 'mcp'],
    'machines.remove': ['cli', 'agent', 'mcp'],
} });

describe('ordinary Machine administration through CLI, Agent and MCP', () => {
    let app = fastify();
    let restore = () => {};
    beforeEach(() => {
        resetActiveAccountSettingsSnapshotForTests();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ actionsSettingsV1: policy }),
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('bound') });
        app = fastify();
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
        restore = installAxiosFastifyAdapter({ app, origin: 'http://home.test' });
    });
    afterEach(async () => { restore(); await app.close(); resetActiveAccountSettingsSnapshotForTests(); });

    it('returns typed client unavailability for metadata rather than borrowing a daemon metadata writer', async () => {
        const credentials = { token: 'bound', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
        const cli = createCliActionExecutor({ token: credentials.token, credentials,
            sessionId: 'cli-global', serverId: 'route-home', serverHttpBaseUrl: 'http://home.test', mode: 'plain', ctx: null });
        expect(await cli.execute('machines.metadata.update', { serverId: 'route-home', machineId: 'old', patch: { displayName: 'New name' } },
            { surface: 'cli', authority: 'present_user', serverId: 'route-home', actionsSettings: policy }))
            .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    });

    it.each(['cli', 'agent', 'mcp'] as const)('invokes replacement and undo through the real %s adapter and preserves the Home refusal', async surface => {
        const setId = ActionIdSchema.parse('machines.replacement.set');
        const clearId = ActionIdSchema.parse('machines.replacement.clear');
        const seen: Array<{ method: string; body: unknown; authorization?: string }> = [];
        app.post('/v1/machines/old/replacement', async request => {
            seen.push({ method: request.method, body: request.body, authorization: request.headers.authorization });
            return {};
        });
        app.delete('/v1/machines/old/replacement', async (_request, reply) => reply.code(409).send({ error: 'machine_not_replaced' }));
        const credentials = { token: 'bound', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
        const cli = createCliActionExecutor({ token: credentials.token, credentials,
            sessionId: 'cli-global', serverId: 'route-home', serverHttpBaseUrl: 'http://home.test', mode: 'plain', ctx: null });
        const invoke = (actionId: typeof setId, input: unknown) => surface === 'cli'
            ? cli.execute(actionId, input, { surface, authority: 'account_automation', serverId: 'route-home', actionsSettings: policy })
            : createActionToolExecutorBridge({ executor: cli, surface, actionsSettings: policy })
                .executeActionByToolName('action_execute', { actionId, input }, 'cli-global',
                    { actionRequestId: `admin-${surface}-${actionId}` });
        const input = { serverId: 'route-home', machineId: 'old', replacementMachineId: 'new', confirmActiveOldMachine: true };
        expect(await invoke(setId, input)).toEqual({ ok: true, result: { ok: true } });
        expect(seen).toEqual([{ method: 'POST', body: { replacementMachineId: 'new', confirmActiveOldMachine: true }, authorization: 'Bearer bound' }]);
        expect(await invoke(clearId, { serverId: 'route-home', machineId: 'old' }))
            .toEqual({ ok: true, result: { ok: false, status: 409, error: 'machine_not_replaced' } });
        expect(await invoke(setId, { ...input, requesterAccountId: 'forged' }))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(seen).toHaveLength(1);
    });

    it.each(['cli', 'agent', 'mcp'] as const)('invokes daemon Stop and refused revocation through %s without Provider cleanup after refusal', async surface => {
        const credentials = { token: 'bound', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
        let stopped = false;
        let revoked = false;
        app.post('/v1/machines/old/revoke', async (_request, reply) => { revoked = true; return reply.code(403).send({ error: 'forbidden' }); });
        const cli = createCliActionExecutor({ token: credentials.token, credentials,
            sessionId: 'cli-global', serverId: 'route-home', serverHttpBaseUrl: 'http://home.test', mode: 'plain', ctx: null,
            // The local Machine RPC transport is a genuine process boundary.
            machineActionDirectTargetTransport: { machineId: 'old', invoke: async method => {
                expect(method).toBe(RPC_METHODS.STOP_DAEMON); stopped = true; return { message: 'Stopped' };
            } },
        });
        const invoke = (actionId: ActionId) => surface === 'cli'
            ? cli.execute(actionId, { serverId: 'route-home', machineId: 'old' }, { surface, authority: 'account_automation', actionsSettings: policy })
            : createActionToolExecutorBridge({ executor: cli, surface, actionsSettings: policy }).executeActionByToolName('action_execute',
                { actionId, input: { serverId: 'route-home', machineId: 'old' } }, 'cli-global', { actionRequestId: `admin-${surface}-${actionId}` });
        expect(await invoke('machines.daemon.stop')).toEqual({ ok: true, result: { message: 'Stopped' } });
        expect(stopped).toBe(true);
        expect(await invoke('machines.remove')).toEqual({ ok: true, result: { ok: false, status: 403, error: 'forbidden' } });
        expect(revoked).toBe(true);
    });
});
