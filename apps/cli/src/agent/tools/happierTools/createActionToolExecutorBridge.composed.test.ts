import { describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { AccountSettingsSchema, ApprovalRequestSchema, createRoleSourceReaderV1, SessionAgentSpawnPolicyV1StrictSchema, SessionSpawnNewInputV2Schema } from '@happier-dev/protocol';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

describe('createActionToolExecutorBridge composed host policy', () => {
  it.each(['agent', 'mcp'] as const)('preserves canonical input diagnostics through the %s tool bridge', async surface => {
    const executor = createActionExecutor({} as ActionExecutorDeps);
    const bridge = createActionToolExecutorBridge({ surface, executor });
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'invalid-directory-bridge',
      executionTarget: { serverId: 'fixture-home', machineId: 'machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    });
    const result = await bridge.executeActionByToolName('action_execute', { actionId: 'session.spawn_new', input: {
      ...input,
      directory: { kind: 'local', path: '/private/submitted-path' },
    } }, 'parent-session');
    expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ errorCode: 'invalid_parameters', details: {
      issues: [{ code: 'invalid_union', path: ['directory', 'kind'], acceptedValues: ['path', 'managed'] }],
    } });
    expect(JSON.stringify(result)).not.toContain('/private/submitted-path');
  });

  it('reads current host permission mode and spawn policy for each Agent invocation', async () => {
    const credentials = { token: 'live-host-account', encryption: null };
    const accountSettings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {
      'session.spawn_new': { approvalRequiredSurfaces: ['agent'] },
    } } });
    const previousSnapshot = getActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot({ scopeKey: resolveAccountSettingsScopeKey(credentials), source: 'network',
      settings: accountSettings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    const app = fastify();
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    app.get('/v1/account/entity-rows/acp', async () => ({ status: 'present', revision: 1,
      content: { t: 'plain', v: { v: 1, definitions: [] } } }));
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: resolveServerHttpBaseUrl() });
    const approvals: unknown[] = [];
    const spawn = vi.fn(async () => { throw new Error('Unapproved child must not start'); });
    // Only Home HTTP, Machine IPC and approval persistence are substituted.
    // Caller resolution, current policy, start admission and approval production stay real.
    const { executor } = createCliActionExecutorHarness({ token: credentials.token, credentials,
      sessionId: 'live-host', mode: 'plain', ctx: null,
      rawSession: { path: '/repo/current', machineId: 'live-machine', workDepth: 0 },
      getCurrentSessionMetadata: () => ({ path: '/repo/current', machineId: 'live-machine', permissionMode: 'read-only' }),
      getCurrentSessionBackendTarget: () => ({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }),
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings, allowEnvironmentOverride: false }),
      readRoleSources: createRoleSourceReaderV1({}),
      sessionSpawnDirectTargetTransport: { machineId: 'live-machine',
        prepare: async () => ({ ok: true, directory: '/repo/child', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: { spawn, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
      },
    }, { approvalsCreate: async ({ request }) => {
      approvals.push(ApprovalRequestSchema.parse(request));
      return { artifactId: 'child-approval' };
    } });
    let permissionMode = 'default';
    let spawnPolicy = SessionAgentSpawnPolicyV1StrictSchema.parse({ allowCustomDirectory: false });
    const bridge = createActionToolExecutorBridge({ surface: 'agent', executor,
      resolveCallerPermissionMode: () => permissionMode,
      getSessionAgentSpawnPolicyV1: () => spawnPolicy,
    });
    const input = { executionTarget: { serverId: 'fixture-home', machineId: 'live-machine' },
      directory: { kind: 'path', path: '/repo/child' }, permissionMode: 'yolo',
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    };
    const execute = () => bridge.executeActionByToolName('action_execute', { actionId: 'session.spawn_new', input }, 'live-host',
      { actionRequestId: 'live-child-request' });
    try {
      await expect(execute()).resolves.toMatchObject({ ok: false, errorCode: 'policy_denied_field', details: { field: 'directory' } });
      spawnPolicy = SessionAgentSpawnPolicyV1StrictSchema.parse({ allowCustomDirectory: true });
      await expect(execute()).resolves.toMatchObject({ ok: false, errorCode: 'permission_exceeds_ceiling' });
      expect(approvals).toEqual([]);
      permissionMode = 'yolo';
      const accepted = await execute();
      expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created', artifactId: 'child-approval' } });
      expect(approvals).toEqual([expect.objectContaining({ actionId: 'session.spawn_new', actionArgs: expect.objectContaining(input) })]);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      restoreHttp();
      await app.close();
      if (previousSnapshot) setActiveAccountSettingsSnapshot(previousSnapshot);
      else resetActiveAccountSettingsSnapshotForTests();
    }
  });
});
