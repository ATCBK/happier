import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

describe('paired terminal Action admission', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it.each([
        { actionId: 'session.role.set', input: { sessionId: 'session-one', roleId: 'builder' }, method: 'execute', output: { updated: true } },
        { actionId: 'session.read_state.set', input: { sessionId: 'session-one', state: 'read' }, method: 'execute',
            output: { state: 'read', lastViewedSessionSeq: 7, didChange: true } },
        { actionId: 'action.spec.search', input: { query: 'triage' }, method: 'execute', output: { actionSpecs: [] } },
        { actionId: 'action.invoke', input: { action: { pluginId: 'acme.source', localId: 'discover' }, input: { v: 1 } },
            method: 'execute', output: { candidates: [] } },
        { actionId: 'session.role.set', input: { sessionId: 'session-one', roleId: 'builder' }, method: 'prepare', output: { updated: true } },
    ] as const)('keeps an own-Machine terminal $actionId $method on its authenticated daemon ingress', async ({ actionId, input, method, output }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-terminal-action-admission-',
            env: { HAPPIER_CLI_PRESENT_USER: 'allowed' } }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            const serverId = configuration.activeServerId;
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: 'owner' });
            const outputSchema = getActionSpec(actionId).outputSchema;
            if (!outputSchema) throw new Error('Fixture requires a schema-backed Action');
            const expected = { ok: true, result: outputSchema.parse(output) };
            // HTTP is the boundary; credential, exact daemon discovery and Action composition stay real.
            vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected Home request'));
            vi.spyOn(axios, 'post').mockResolvedValue({ status: 401, data: { error: 'invalid_token' } });
            vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
                expect(String(url)).toBe('http://127.0.0.1:43123/actions/root/execute');
                expect(options.headers).toMatchObject({ 'x-happier-daemon-token': 'fixture-control-token' });
                expect(JSON.parse(String(options.body))).toMatchObject({ actionId, input });
                return Response.json(expected);
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test', machineId: 'own-machine',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const result = method === 'execute' ? await executor.execute(actionId, input, { surface: 'cli' })
                : await (async () => {
                    const prepared = await executor.prepare(actionId, input, { surface: 'cli' });
                    return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
                })();
            expect(result).toEqual(expected);
        });
    });

    it.each([
        { explicitMachine: false, daemonAccountId: 'owner', own: true },
        { explicitMachine: true, daemonAccountId: 'owner', own: true },
        { explicitMachine: false, daemonAccountId: 'different-account', own: false },
    ])('routes a declared client Action only through its own Account daemon ($explicitMachine/$daemonAccountId)', async ({ explicitMachine, daemonAccountId, own }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-terminal-client-admission-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            const serverId = configuration.activeServerId;
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: daemonAccountId });
            const surface = { serverId: 'srv_home', accountId: 'owner',
                owner: { kind: 'project' as const, projectId: 'project', layoutId: 'notes' } };
            // Mock only HTTP: both Action factories, stored provenance and daemon discovery remain real.
            vi.spyOn(axios, 'get').mockRejectedValue(new Error('Own client placement must not need Home Machine admission'));
            vi.spyOn(axios, 'post').mockRejectedValue(new Error('A terminal is not a PAT'));
            vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
                expect(String(url)).toBe('http://127.0.0.1:43123/actions/root/execute');
                expect(options.headers).toMatchObject({ 'x-happier-daemon-token': 'fixture-control-token' });
                expect(JSON.parse(String(options.body))).toMatchObject({ actionId: 'widgets.area.layout.select', input: { surface } });
                expect(new Headers(options.headers).get(AUTHORITY_CEILING_HEADER_V1)).toBe('account_automation');
                return Response.json({ ok: true, result: { surface, instances: [], canEdit: true } });
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                ...(explicitMachine ? { machineId: 'own-machine' } : {}),
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            expect(await executor.execute('widgets.area.layout.select', { surface }, { surface: 'cli', authority: 'account_automation' }))
                .toEqual(own ? { ok: true, result: { surface, instances: [], canEdit: true } }
                    : { ok: false, errorCode: 'unavailable', error: 'noClient' });
        });
    });

    it.each([
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: undefined, errorCode: null },
        { outerTarget: true, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: undefined, errorCode: null },
        { outerTarget: false, daemonAccountId: 'different-account', terminalPolicy: 'allowed', authority: undefined, errorCode: 'target_unavailable' },
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'allowed', authority: 'account_automation', errorCode: 'invalid_parameters' },
        { outerTarget: false, daemonAccountId: 'owner', terminalPolicy: 'disallowed', authority: undefined, errorCode: 'invalid_parameters' },
    ] as const)('preserves exact Home/Account and terminal policy ($outerTarget/$daemonAccountId/$terminalPolicy/$authority)', async ({ outerTarget, daemonAccountId, terminalPolicy, authority, errorCode }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-terminal-create-admission-',
            env: { HAPPIER_CLI_PRESENT_USER: terminalPolicy } }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            const serverId = configuration.activeServerId;
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: daemonAccountId });
            const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'terminal-create',
                executionTarget: { serverId, machineId: 'own-machine' }, directory: { kind: 'managed' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } });
            // HTTP and persisted daemon publication are the system boundaries;
            // credential provenance, target resolution and both Action factories are real.
            vi.spyOn(axios, 'get').mockImplementation(async (url) => {
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                if (url.endsWith('/v1/machines/own-machine')) return { status: 200, data: { machine: {
                    id: 'own-machine', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
                    dataEncryptionKey: null, runnerContentKeyBinding: null } } };
                throw new Error(`Unexpected HTTP read: ${url}`);
            });
            vi.spyOn(axios, 'post').mockRejectedValue(new Error('Session creation is not a terminal Home finite Action'));
            vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
                expect(String(url)).toBe('http://127.0.0.1:43123/actions/root/execute');
                expect(options.headers).toMatchObject({ 'x-happier-daemon-token': 'fixture-control-token' });
                expect(JSON.parse(String(options.body))).toMatchObject({ actionId: 'session.spawn_new', input });
                // Mirror the existing receiver: an automation ceiling has no
                // bare terminal creation namespace and must not become human.
                if (new Headers(options.headers).get(AUTHORITY_CEILING_HEADER_V1) === 'account_automation') {
                    return Response.json({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
                }
                return Response.json({ ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } });
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                ...(outerTarget ? { machineId: 'own-machine' } : {}),
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const result = await executor.execute('session.spawn_new', input, { surface: 'cli', ...(authority ? { authority } : {}) });
            expect(result).toEqual(errorCode === null
                ? { ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } }
                : { ok: false, errorCode, error: errorCode });
        });
    });
});
