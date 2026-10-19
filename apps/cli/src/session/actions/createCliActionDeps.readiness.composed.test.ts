import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionReadinessV1Schema } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

it('reads on demand, repairs through the real sign-in Action, and observes the acknowledged native setup', async () => {
  const sessionId = 'c123456789012345678901234';
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
    metadata: JSON.stringify({ machineId: 'machine-1', flavor: 'codex', path: '/workspace' }),
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
  let invokeAllowed = true;
  let machineOnline = true;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: { ...row,
      effectiveAccess: { v: 1, level: invokeAllowed ? 'owner' : 'view', sources: [],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: invokeAllowed, grants: [] }) } } } };
    if (path === '/v1/machines') return { status: 200, data: [{ id: 'machine-1', active: machineOnline,
      revokedAt: null, replacedByMachineId: null, kind: 'persistent',
      access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }] };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  let signedIn = false;
  const calls: string[] = [];
  const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
    mode: 'plain', ctx: null, sessionId: '', serverId: 'home-a', serverHttpBaseUrl: 'https://readiness.test',
    machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: async (method) => {
      calls.push(method);
      if (method === 'daemon.extensions.contributionRegistryProjection.describe') return { protocolVersion: 1,
        projection: { v: 2, generation: 1, familiesById: {}, agentsById: { codex: { id: 'codex', title: 'Codex',
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } } } };
      if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.codex': {
        ok: true, checkedAt: Date.now(), data: { installed: true, available: true, resolvedPath: '/agent/codex',
          version: null, latestVersion: null, update: { supported: false, command: null },
          signIn: { status: signedIn ? 'signedIn' : 'signedOut', loginSupport: 'login_terminal' },
          platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] },
      } } };
      if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: 'codex' } };
      if (method === 'daemon.terminal.ensure') return { ok: true, terminalId: 'login-terminal', reused: false };
      throw new Error(`Unexpected Machine operation ${method}`);
    } },
  }));
  const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home-a' };
  expect((await executor.execute('session.status.get', { sessionId }, context)).ok).toBe(true);
  expect(calls).toEqual([]);
  const unavailable = await executor.execute('session.status.get', { sessionId, readiness: true }, context);
  expect(unavailable).toMatchObject({ ok: true, result: { readiness: { configured: true, status: 'unavailable', cause: 'agent' } } });
  if (!unavailable.ok) throw new Error(unavailable.errorCode);
  const result = SessionStatusActionResultV1Schema.parse(unavailable.result);
  if (result.ok === false || !result.readiness) throw new Error('Missing current readiness');
  const readiness = SessionReadinessV1Schema.parse(result.readiness);
  const repair = readiness.agent?.repair;
  if (!repair) throw new Error('Missing entitled native repair');
  const repaired = await executor.execute(repair.actionId, repair.input, { ...context,
    presentUserConfirmation: { actionId: repair.actionId } });
  expect(repaired).toMatchObject({ ok: true, result: { terminalId: 'login-terminal' } });
  signedIn = true; // OS/native login acknowledgement at the substituted Machine boundary.
  expect(await executor.execute('session.status.get', { sessionId, readiness: true }, context))
    .toMatchObject({ ok: true, result: { readiness: { status: 'ready', cause: null } } });
  machineOnline = false;
  expect(await executor.execute('session.status.get', { sessionId, readiness: true }, context))
    .toMatchObject({ ok: true, result: { readiness: { status: 'unavailable', cause: 'machine', machine: { status: 'offline' } } } });
  invokeAllowed = false;
  expect(await executor.execute('session.status.get', { sessionId, readiness: true }, context))
    .toMatchObject({ ok: true, result: { session: { id: sessionId }, readiness: { status: 'unavailable', cause: 'invocation' } } });
  expect(calls.filter(method => method === 'capabilities.detect')).toHaveLength(2);
  expect(calls.filter(method => method === 'daemon.terminal.ensure')).toHaveLength(1);
});
