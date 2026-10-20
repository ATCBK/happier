import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord, QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol';
import { ApiClient } from '@/api/api';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { reloadConfiguration } from '@/configuration';
import { logger } from '@/utils/logger';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import {
  resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn,
} from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
  resolveFirstPartyLegacyAgentConnectedAccountServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import {
  materializeConnectedServicesForSpawn as materializeConnectedServicesForSpawnProduction,
  runSerializedMaterialization,
} from './materializeConnectedServicesForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceHomeDir } from '../homes/resolveConnectedServiceHomeDir';
import { readConnectedServiceStateSharingManifest } from '../stateSharing/connectedServiceStateSharingManifest';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createExecutionRunConnectedServicesBridge } from '../runs/executionRunMaterialization';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { verifyResumeReachableThroughCatalog } from '../catalogHooks';
import { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import { materializeExactV021ConnectedServiceCredential } from '../compatibility/exactV021ConnectedServiceMaterialization';
import {
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
} from '../connectedServiceChildEnvironment';

type MaterializeParams = Parameters<typeof materializeConnectedServicesForSpawnProduction>[0];

let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;

function isMaterializationPhase(fields: unknown, materializationKey: string, phase: string, status: string): boolean {
  return typeof fields === 'object' && fields !== null
    && 'materializationKey' in fields && fields.materializationKey === materializationKey
    && 'phase' in fields && fields.phase === phase
    && 'status' in fields && fields.status === status;
}

it('prepares an isolated requester Agent home without a Connected Account for Provider or API-key authentication', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'requester-native-only-'));
  try {
    const aliceHome = join(baseDir, 'alice-native');
    await mkdir(aliceHome);
    await writeFile(join(aliceHome, 'auth.json'), JSON.stringify({ access_token: 'alice-login' }));
    let requesterVerifications = 0;
    const materialized = await materializeConnectedServicesForSpawnProduction({
      agentId: 'codex', materializationKey: 'bob-session', activeServerDir: baseDir,
      baseDir: join(baseDir, 'bob-materialized'), recordsByServiceId: new Map(), allowNativeAccountState: false,
      processEnv: { CODEX_HOME: aliceHome }, isAccountRuntimeCurrent: async () => {
        requesterVerifications++;
        return true;
      },
    });
    expect(materialized?.env.CODEX_HOME).toBe(materialized?.targetMaterializedRoot);
    expect(materialized?.env.CODEX_HOME).toBeTruthy();
    expect(existsSync(join(materialized!.env.CODEX_HOME!, 'auth.json'))).toBe(false);
    expect(await readFile(join(aliceHome, 'auth.json'), 'utf8')).toContain('alice-login');
    // This no-credential launch has five artifact effects: staging,
    // native-home preparation, staging/target finalization and promotion. Each
    // retains fresh entry/exit authority; individual preparation files must
    // not add another Home round trip around the same preparation.
    expect(requesterVerifications).toBe(10);
    await materialized?.cleanupOnExit?.();
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});

it.each(['revocation', 'cancellation'] as const)('refuses native-home publication after %s during preparation', async (failure) => {
  const baseDir = await mkdtemp(join(tmpdir(), 'requester-native-preparation-'));
  const materializationKey = 'refused-native-preparation';
  const materializedBase = join(baseDir, 'materialized');
  const rootDir = resolveConnectedServiceMaterializedRootDir({
    baseDir: materializedBase, agentId: 'codex', materializationKey,
  });
  let current = true;
  let interrupted = false;
  const cancellation = new AbortController();
  const originalLog = logger.infoFile.bind(logger);
  // File logging is the system boundary: retire authority after real native
  // state preparation, keeping the filesystem and materializer owners real.
  const log = vi.spyOn(logger, 'infoFile').mockImplementation((message, fields) => {
    originalLog(message, fields);
    if (message === '[CONNECTED ACCOUNT] Materialization phase'
      && isMaterializationPhase(fields, materializationKey, 'native_home_state', 'completed')) {
      interrupted = true;
      if (failure === 'revocation') current = false;
      else cancellation.abort(new Error('fixture_materialization_cancelled'));
    }
  });
  try {
    await expect(materializeConnectedServicesForSpawnProduction({
      agentId: 'codex', materializationKey, activeServerDir: baseDir,
      baseDir: materializedBase, recordsByServiceId: new Map(), allowNativeAccountState: false,
      signal: cancellation.signal, isAccountRuntimeCurrent: async () => current,
    })).rejects.toThrow(failure === 'revocation'
      ? 'requester_account_context_unavailable' : 'fixture_materialization_cancelled');
    expect(interrupted).toBe(true);
    expect(existsSync(rootDir)).toBe(false);
  } finally {
    log.mockRestore();
    await rm(baseDir, { recursive: true, force: true });
  }
});

beforeAll(async () => {
  runtimeFixture = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: {
      pluginIds: [
        'happier.agent.claude',
        'happier.agent.codex',
        'happier.agent.gemini',
        'happier.agent.opencode',
        'happier.agent.pi',
      ],
    },
  });
});

afterAll(async () => {
  await runtimeFixture?.dispose();
  runtimeFixture = null;
});

async function materializeConnectedServicesForSpawn(
  params: MaterializeParams,
): ReturnType<typeof materializeConnectedServicesForSpawnProduction> {
  const declarationSnapshot =
    resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: params.agentId,
      contributions: runtimeFixture!.registry.contributes,
    });
  if (!declarationSnapshot) {
    throw new Error(`Missing Connected Account declaration snapshot for ${params.agentId}`);
  }
  const bindings = declarationSnapshot.authorizedPurposes.flatMap((scope) => {
    const service = scope.serviceRefs[0];
    if (!service) return [];
    const serviceId =
      resolveFirstPartyLegacyAgentConnectedAccountServiceId(service);
    if (!serviceId) return [];
    const record = params.recordsByServiceId.get(serviceId);
    if (!record) return [];
    const selection = params.selectionsByServiceId?.get(serviceId);
    return [{
      purpose: scope.purpose,
      target: selection?.kind === 'group'
        ? {
            kind: 'group' as const,
            service,
            groupId: selection.groupId,
          }
        : {
            kind: 'account' as const,
            account: { service, accountId: record.profileId },
          },
    }];
  });
  return await materializeConnectedServicesForSpawnProduction({
    ...params,
    connectedAccountMaterializationAuthority:
      LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    qualifiedPurposeBindingSnapshot: {
      ...declarationSnapshot,
      bindings,
    },
  });
}

const LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY = {
  kind: 'legacy_unfenced_one_shot',
} as const satisfies MaterializeParams['connectedAccountMaterializationAuthority'];

describe('materializeConnectedServicesForSpawn', () => {
  it('keeps qualified account native state separate from each Session request-auth capability root', async () => {
    // File logging is the diagnostic boundary; binding, plugin serialization, queues and disk stay real.
    const log = vi.spyOn(logger, 'infoFile');
    const root = await mkdtemp(join(tmpdir(), 'happier-qualified-native-home-'));
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: 'codex', contributions: runtimeFixture!.registry.contributes,
    })!;
    const scope = declaration.fileMaterializationPurposes[0]!;
    const account = { service: scope.serviceRefs[0]!, accountId: 'work' };
    const binding = { purpose: scope.purpose, target: { kind: 'account' as const, account } };
    let record = buildConnectedServiceCredentialRecord({
      now: 10, serviceId: 'openai-codex', profileId: account.accountId, kind: 'oauth', expiresAt: 100000,
      oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id',
        scope: null, tokenType: null, providerAccountId: 'fixture-account', providerEmail: null },
    });
    const unusedAccountBoundary = async (): Promise<never> => { throw new Error('Unexpected account inventory I/O'); };
    let capturedAccount: (() => void) | null = null;
    // The real binding owner resolves synthetic account metadata and invokes the admitted
    // plugin credential serializer; no internal account/materialization logic is mocked.
    const owner = createConnectedAccountPurposeBindingOwner({
      store: { read: unusedAccountBoundary, update: unusedAccountBoundary, subscribe: () => ({ dispose() {} }) },
      selectTarget: unusedAccountBoundary,
      resolveTarget: async target => {
        capturedAccount?.();
        capturedAccount = null;
        return target.kind === 'account'
          ? { displayName: target.account.accountId, account: target.account } : null;
      },
      projectTargetAccounts: unusedAccountBoundary,
      assertTargetAccountMaterializable: async input => {
        if (input.account.accountId !== account.accountId) throw new Error('Fixture account admission refused');
      },
      materializeAccount: async input => await materializeExactV021ConnectedServiceCredential({
        registry: runtimeFixture!.registry, serviceId: 'openai-codex', account: input.account,
        record, request: input.request, signal: input.signal,
      }),
    });
    const leases = ['qualified-first', 'qualified-second', 'qualified-after-rotation', 'qualified-refused'].map(sessionId => owner.activateSessionPurposeBindings({
      sessionId, purposes: declaration.purposes, bindings: [binding],
    }));
    try {
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'qualified-first', purposeBindingSessionId: 'qualified-first',
        activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
        connectedAccountsOwner: owner, processEnv: {},
        connectedAccountMaterializationAuthority: {
          kind: 'qualified', purposeBindings: [binding], requestAuthPurposeBindings: [binding],
        },
        qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [binding] },
      };
      const first = await materializeConnectedServicesForSpawnProduction(params);
      const second = await materializeConnectedServicesForSpawnProduction({
        ...params, materializationKey: 'qualified-second', purposeBindingSessionId: 'qualified-second',
      });
      expect(first!.env.CODEX_HOME).toBe(second!.env.CODEX_HOME);
      expect(first!.requestAuthMaterializedRoot).not.toBe(first!.targetMaterializedRoot);
      expect(first!.requestAuthMaterializedRoot).not.toBe(second!.requestAuthMaterializedRoot);
      await first!.cleanupOnExit!();
      expect(existsSync(first!.requestAuthMaterializedRoot!)).toBe(false);
      expect(await readFile(join(second!.env.CODEX_HOME!, 'auth.json'), 'utf8')).toContain('fixture-access');
      // Credential reads are owned by the qualified purpose materializer, not
      // the refresh caller's captured record. Queue behind the actual home
      // lock, replace that external credential, then prove current bytes win.
      let releaseHome!: () => void;
      let enteredHome!: () => void;
      const homeEntered = new Promise<void>(resolve => { enteredHome = resolve; });
      const homeReleased = new Promise<void>(resolve => { releaseHome = resolve; });
      const heldHome = runSerializedMaterialization(second!.env.CODEX_HOME!, async () => {
        enteredHome();
        await homeReleased;
      });
      await homeEntered;
      const accountCaptured = new Promise<void>(resolve => { capturedAccount = resolve; });
      const capturedRecord = record;
      let measuredTime = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => measuredTime);
      const queued = materializeConnectedServicesForSpawnProduction({
        ...params, materializationKey: 'qualified-after-rotation', purposeBindingSessionId: 'qualified-after-rotation',
        recordsByServiceId: new Map([['openai-codex', capturedRecord]]),
      });
      try {
        await accountCaptured;
        await vi.waitFor(() => expect(log).toHaveBeenCalledWith(
          '[CONNECTED ACCOUNT] Materialization phase',
          expect.objectContaining({ materializationKey: 'qualified-after-rotation', phase: 'native_home_queue', status: 'started' }),
        ));
        expect(log.mock.calls.some(([message, fields]) => message === '[CONNECTED ACCOUNT] Materialization phase'
          && isMaterializationPhase(fields, 'qualified-after-rotation', 'native_home_queue', 'completed'))).toBe(false);
        record = buildConnectedServiceCredentialRecord({
          now: 20, serviceId: 'openai-codex', profileId: account.accountId, kind: 'oauth', expiresAt: 100000,
          oauth: { accessToken: 'newest-access', refreshToken: 'newest-refresh', idToken: 'newest-id',
            scope: null, tokenType: null, providerAccountId: 'fixture-account', providerEmail: null },
        });
      } finally {
        measuredTime = 250_000;
        releaseHome();
        // An assertion failure must still settle the live writer before retiring its fixture authority.
        try {
          await heldHome;
          await queued;
        } finally {
          clock.mockRestore();
        }
      }
      await heldHome;
      const rotated = await queued;
      expect(rotated!.env.CODEX_HOME).toBe(second!.env.CODEX_HOME);
      expect(await readFile(join(rotated!.env.CODEX_HOME!, 'auth.json'), 'utf8')).toContain('newest-access');
      expect(await readFile(join(rotated!.env.CODEX_HOME!, 'auth.json'), 'utf8')).not.toContain('fixture-access');
      for (const phase of ['native_home_queue', 'native_home_state', 'native_home_credentials']) {
        expect(log).toHaveBeenCalledWith('[CONNECTED ACCOUNT] Materialization phase', expect.objectContaining({
          materializationKey: 'qualified-after-rotation', phase, status: 'completed',
          durationMs: phase === 'native_home_queue' ? 250_000 : 0,
        }));
      }
      const credentialReadError = new Error('fixture-private-credential-error');
      capturedAccount = () => { throw credentialReadError; };
      await expect(materializeConnectedServicesForSpawnProduction({
        ...params, materializationKey: 'qualified-refused', purposeBindingSessionId: 'qualified-refused',
      })).rejects.toBe(credentialReadError);
      expect(log).toHaveBeenCalledWith('[CONNECTED ACCOUNT] Materialization phase', expect.objectContaining({
        materializationKey: 'qualified-refused', phase: 'binding_read', status: 'failed', durationMs: expect.any(Number),
      }));
      const diagnostics = log.mock.calls.filter(([message]) => message === '[CONNECTED ACCOUNT] Materialization phase');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics).toContainEqual(['[CONNECTED ACCOUNT] Materialization phase', expect.objectContaining({
        materializationKey: 'qualified-after-rotation', phase: 'native_home_credentials', status: 'completed',
        service: account.service,
      })]);
      for (const phase of ['materialization_binding_before', 'materialization_invoke', 'materialization_binding_after']) {
        expect(diagnostics).toContainEqual(['[CONNECTED ACCOUNT] Materialization phase', expect.objectContaining({
          materializationKey: 'qualified-after-rotation', phase, status: 'completed', parentPhaseId: expect.any(String),
          service: account.service,
        })]);
      }
      for (const [, fields] of diagnostics) {
        expect(Object.keys(fields!).sort()).toEqual(
          ['agentId', 'durationMs', 'materializationKey', 'phase', 'phaseId', 'status',
            ...(Object.hasOwn(fields!, 'service') ? ['service'] : []),
            ...(Object.hasOwn(fields!, 'parentPhaseId') ? ['parentPhaseId'] : [])].sort(),
        );
      }
      expect(JSON.stringify(diagnostics)).not.toMatch(/fixture-access|fixture-refresh|newest-access|newest-refresh|fixture-private-credential-error/);
      await rotated!.cleanupOnExit!();
      await second!.cleanupOnExit!();
    } finally {
      log.mockRestore();
      for (const lease of leases) lease.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { agentId: 'codex', serviceId: 'openai-codex', environmentKey: 'CODEX_HOME', stateEntry: 'sessions' },
    { agentId: 'claude', serviceId: 'claude-subscription', environmentKey: 'CLAUDE_CONFIG_DIR', stateEntry: 'projects' },
  ] as const)('reuses the $agentId account home across Session identities without retiring native state', async ({
    agentId, serviceId, environmentKey, stateEntry,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-stable-account-home-'));
    try {
      const record = buildConnectedServiceCredentialRecord({
        now: 10, serviceId, profileId: 'work', kind: 'oauth', expiresAt: 100000,
        oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id',
          scope: null, tokenType: null, providerAccountId: 'fixture-account', providerEmail: null },
      });
      const params: MaterializeParams = {
        agentId, materializationKey: 'first-session', activeServerDir: join(root, 'server'),
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map([[serviceId, record]]),
        processEnv: {}, accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      };
      const oldHome = resolveConnectedServiceMaterializedRootDir({
        baseDir: params.baseDir, agentId, materializationKey: params.materializationKey,
      });
      const oldTranscript = join(oldHome, stateEntry, 'legacy-session.jsonl');
      await mkdir(join(oldHome, stateEntry), { recursive: true });
      await writeFile(oldTranscript, '{"sessionId":"legacy-session"}\n');
      const first = await materializeConnectedServicesForSpawn(params);
      const home = first!.env[environmentKey]!;
      expect(home).toBe(join(resolveConnectedServiceHomeDir({
        activeServerDir: params.activeServerDir, serviceId, profileId: record.profileId, agentId,
      }), agentId === 'codex' ? 'codex-home' : 'claude-config'));
      expect(home).not.toBe(oldHome);
      expect(await readFile(join(home, stateEntry, 'legacy-session.jsonl'), 'utf8')).toContain('legacy-session');
      expect(await readFile(oldTranscript, 'utf8')).toContain('legacy-session');
      const transcript = join(home, stateEntry, 'fixture-session.jsonl');
      await mkdir(join(home, stateEntry), { recursive: true });
      await writeFile(transcript, '{"sessionId":"fixture-session"}\n');
      await first!.cleanupOnExit!();
      expect(await readFile(oldTranscript, 'utf8')).toContain('legacy-session');
      const second = await materializeConnectedServicesForSpawn({ ...params, materializationKey: 'second-session' });
      expect(second!.env[environmentKey]).toBe(home);
      expect(await readFile(transcript, 'utf8')).toContain('fixture-session');
      await second!.cleanupOnExit!();
      expect(await readFile(transcript, 'utf8')).toContain('fixture-session');
      if (agentId === 'claude' && record.kind === 'oauth') {
        const approvalConfig = join(home, '.claude.json');
        const privateMemory = join(home, stateEntry, 'memory', 'private.md');
        await writeFile(approvalConfig, '{"approvalMarker":"retain-native-approval"}');
        await mkdir(join(home, stateEntry, 'memory'), { recursive: true });
        await writeFile(privateMemory, 'retain-native-memory');
        const refreshed = await materializeConnectedServicesForSpawn({
          ...params, materializationKey: 'refreshed-session',
          recordsByServiceId: new Map([[serviceId, {
            ...record, oauth: { ...record.oauth, accessToken: 'fixture-refreshed-access' },
          }]]),
        });
        expect(refreshed!.env[environmentKey]).toBe(home);
        expect(await readFile(join(home, '.credentials.json'), 'utf8')).toContain('fixture-refreshed-access');
        expect(await readFile(approvalConfig, 'utf8')).toContain('retain-native-approval');
        expect(await readFile(privateMemory, 'utf8')).toBe('retain-native-memory');
        expect(await readFile(transcript, 'utf8')).toContain('fixture-session');
        await refreshed!.cleanupOnExit!();
      }
      const sharedSource = join(root, 'native');
      await mkdir(join(sharedSource, stateEntry), { recursive: true });
      await writeFile(join(sharedSource, stateEntry, 'native-session.jsonl'), '{"sessionId":"native-session"}\n');
      if (agentId === 'codex') {
        await writeFile(join(sharedSource, 'history.jsonl'), '{"session_id":"native-session","text":"native"}\n');
        await writeFile(join(home, 'history.jsonl'), '{"session_id":"fixture-session","text":"private"}\n');
        await writeFile(join(sharedSource, 'session_index.jsonl'), '{"id":"native-session","updated_at":"2026-09-01T00:00:00.000Z"}\n');
        await writeFile(join(home, 'session_index.jsonl'), '{"id":"fixture-session","updated_at":"2026-09-02T00:00:00.000Z"}\n');
      }
      const shared = await materializeConnectedServicesForSpawn({
        ...params, materializationKey: 'shared-session', processEnv: { [environmentKey]: sharedSource },
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'shared' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      });
      expect(shared!.env[environmentKey]).toBe(home);
      expect(await readFile(join(sharedSource, stateEntry, 'fixture-session.jsonl'), 'utf8')).toContain('fixture-session');
      expect(await readFile(transcript, 'utf8')).toContain('fixture-session');
      if (agentId === 'codex') {
        expect(await readFile(join(home, 'history.jsonl'), 'utf8')).toContain('fixture-session');
        expect(await readFile(join(home, 'history.jsonl'), 'utf8')).toContain('native-session');
        expect(await readFile(join(home, 'session_index.jsonl'), 'utf8')).toContain('fixture-session');
        expect(await readFile(join(home, 'session_index.jsonl'), 'utf8')).toContain('native-session');
      }
      await shared!.cleanupOnExit!();
      const probeParams = { ...params, materializationKey: 'probe-fixture', probePurpose: 'probe' as const };
      const probe = await materializeConnectedServicesForSpawn(probeParams);
      const probeHome = probe!.env[environmentKey]!;
      expect(probeHome).not.toBe(home);
      await expect(lstat(join(probeHome, stateEntry))).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(join(probeHome, stateEntry), { recursive: true });
      await writeFile(join(probeHome, stateEntry, 'probe-session.jsonl'), '{"sessionId":"probe-session"}\n');
      await probe!.cleanupOnExit!();
      expect(existsSync(probeHome)).toBe(false);
      expect(await readFile(transcript, 'utf8')).toContain('fixture-session');
      const groupParams = { ...params, selectionsByServiceId: new Map([[serviceId, {
        kind: 'group' as const, serviceId, groupId: 'pool', activeProfileId: record.profileId,
        fallbackProfileId: record.profileId, generation: 1, policy: {},
      }]]) };
      const groupFirst = await materializeConnectedServicesForSpawn({ ...groupParams, materializationKey: 'group-first' });
      const groupSecond = await materializeConnectedServicesForSpawn({ ...groupParams, materializationKey: 'group-second' });
      expect(groupFirst!.env[environmentKey]).not.toBe(home);
      expect(groupSecond!.env[environmentKey]).toBe(groupFirst!.env[environmentKey]);
      await groupFirst!.cleanupOnExit!();
      await groupSecond!.cleanupOnExit!();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['physical', 'aliased'] as const)('adopts only the resumed conversation across account selection with a %s base without trusting user or foreign homes', async base => {
    const root = await mkdtemp(join(tmpdir(), 'happier-prior-connected-home-'));
    try {
      const physicalServerDir = join(root, 'server');
      const activeServerDir = base === 'aliased' ? join(root, 'server-alias') : physicalServerDir;
      if (base === 'aliased') {
        await mkdir(physicalServerDir);
        await symlink(physicalServerDir, activeServerDir, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const priorHome = join(resolveConnectedServiceHomeDir({
        activeServerDir, serviceId: 'openai-codex', profileId: 'account-a', agentId: 'codex',
      }), 'codex-home');
      await mkdir(join(priorHome, 'sessions'), { recursive: true });
      const vendorResumeId = '11111111-2222-4333-8444-555555555555';
      const rolloutName = `rollout-2026-10-12T10-00-00-${vendorResumeId}.jsonl`;
      await writeFile(join(priorHome, 'sessions', rolloutName), '{"sessionId":"retained-session"}\n');
      await writeFile(join(priorHome, 'sessions', 'unrelated-session.jsonl'), 'unrelated-private-session');
      await mkdir(join(priorHome, 'archived_sessions'), { recursive: true });
      await writeFile(join(priorHome, 'archived_sessions', 'private.jsonl'), 'unrelated-private-archive');
      await mkdir(join(priorHome, 'memories'), { recursive: true });
      await writeFile(join(priorHome, 'memories', 'private.md'), 'unrelated-private-memory');
      await writeFile(join(priorHome, 'history.jsonl'), '{"session_id":"unrelated-account-history"}\n');
      const record = buildConnectedServiceCredentialRecord({
        now: 10, serviceId: 'openai-codex', profileId: 'account-b', kind: 'oauth', expiresAt: 100000,
        oauth: { accessToken: 'account-b-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id',
          scope: null, tokenType: null, providerAccountId: 'account-b', providerEmail: null },
      });
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'resumed-session', activeServerDir,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map([['openai-codex', record]]),
        processEnv: {}, allowNativeAccountState: false,
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      };
      // Persisted binding IDs may already identify B while the last process still used A.
      const descriptor = {
        v: 1 as const, agentId: 'codex', agent: {
          backendMode: 'appServer', home: 'connectedService', homePath: priorHome,
          connectedServiceId: 'openai-codex', connectedServiceProfileId: record.profileId,
        },
      };
      const resumedParams = { ...params, runtimeDescriptorV1: descriptor, vendorResumeId };
      const resumed = await materializeConnectedServicesForSpawn(resumedParams);
      const nextHome = resumed!.env.CODEX_HOME!;
      expect(nextHome).not.toBe(priorHome);
      expect(await readFile(join(nextHome, 'sessions', rolloutName), 'utf8')).toContain('retained-session');
      expect(await readFile(join(priorHome, 'sessions', rolloutName), 'utf8')).toContain('retained-session');
      const unrelatedPaths = ['sessions/unrelated-session.jsonl', 'archived_sessions/private.jsonl', 'memories/private.md', 'history.jsonl'];
      for (const path of unrelatedPaths) {
        await expect(lstat(join(nextHome, path))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(priorHome, path), 'utf8')).toContain('unrelated');
      }
      expect(await readFile(join(nextHome, 'auth.json'), 'utf8')).toContain('account-b-access');
      await resumed!.cleanupOnExit!();
      const freshRecord = { ...record, profileId: 'fresh-account' };
      const fresh = await materializeConnectedServicesForSpawn({
        ...params, materializationKey: 'fresh-session', runtimeDescriptorV1: descriptor,
        recordsByServiceId: new Map([['openai-codex', freshRecord]]),
      });
      for (const path of [`sessions/${rolloutName}`, ...unrelatedPaths]) {
        await expect(lstat(join(fresh!.env.CODEX_HOME!, path))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await fresh!.cleanupOnExit!();
      const foreignHome = join(root, 'foreign-home');
      await mkdir(foreignHome);
      const redirectedHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'redirected-home');
      await symlink(foreignHome, redirectedHome, process.platform === 'win32' ? 'junction' : 'dir');
      for (const [home, source] of [
        ['user', priorHome], ['connectedService', foreignHome], ['connectedService', redirectedHome],
      ] as const) {
        await mkdir(join(source, 'sessions'), { recursive: true });
        await writeFile(join(source, 'sessions', 'untrusted-session.jsonl'), 'untrusted-history');
        const candidateParams = {
          ...params, materializationKey: `untrusted-${home}`,
          runtimeDescriptorV1: { ...descriptor, agent: { ...descriptor.agent, home, homePath: source } },
        };
        const candidate = await materializeConnectedServicesForSpawn(candidateParams);
        expect(existsSync(join(candidate!.env.CODEX_HOME!, 'sessions', 'untrusted-session.jsonl'))).toBe(false);
        await candidate!.cleanupOnExit!();
      }
      const redirectedServer = join(root, 'redirected-server');
      await mkdir(join(redirectedServer, 'daemon', 'connected-services'), { recursive: true });
      await symlink(foreignHome, join(redirectedServer, 'daemon', 'connected-services', 'homes'),
        process.platform === 'win32' ? 'junction' : 'dir');
      await expect(materializeConnectedServicesForSpawn({
        ...params, activeServerDir: redirectedServer, materializationKey: 'redirected-server-session',
      })).rejects.toThrow('connected_service_materialization_root_unsafe');
      expect(existsSync(join(foreignHome, 'openai-codex', record.profileId, 'codex', 'codex-home', 'auth.json'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { agentId: 'claude', environmentKey: 'CLAUDE_CONFIG_DIR', stateEntry: 'projects', sourcePresent: false },
    { agentId: 'claude', environmentKey: 'CLAUDE_CONFIG_DIR', stateEntry: 'projects', sourcePresent: true },
    { agentId: 'codex', environmentKey: 'CODEX_HOME', stateEntry: 'sessions', sourcePresent: false },
    { agentId: 'codex', environmentKey: 'CODEX_HOME', stateEntry: 'sessions', sourcePresent: true },
    { agentId: 'pi', environmentKey: 'PI_CODING_AGENT_DIR', stateEntry: 'sessions', sourcePresent: false },
    { agentId: 'pi', environmentKey: 'PI_CODING_AGENT_DIR', stateEntry: 'sessions', sourcePresent: true },
  ] as const)('preserves $agentId state through live rematerialization with native source present=$sourcePresent', async ({
    agentId, environmentKey, stateEntry, sourcePresent,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-linked-native-state-'));
    try {
      const nativeHome = join(root, 'native');
      await mkdir(nativeHome);
      if (sourcePresent) await mkdir(join(nativeHome, stateEntry));
      const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
        agentId, contributions: runtimeFixture!.registry.contributes,
      });
      expect(declaration).not.toBeNull();
      // Keep the real account owner; this state-only fixture admits no account I/O.
      const unavailableAccountBoundary = async (): Promise<never> => {
        throw new Error('Credential-free state fixture must not access accounts');
      };
      const connectedAccountsOwner = createConnectedAccountPurposeBindingOwner({
        store: {
          read: unavailableAccountBoundary, update: unavailableAccountBoundary,
          subscribe: () => ({ dispose() {} }),
        },
        selectTarget: unavailableAccountBoundary,
        resolveTarget: unavailableAccountBoundary,
        materializeAccount: unavailableAccountBoundary,
        projectTargetAccounts: unavailableAccountBoundary,
        assertTargetAccountMaterializable: unavailableAccountBoundary,
      });
      const params: MaterializeParams = {
        agentId, materializationKey: 'csm_linked-native-state', activeServerDir: root,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
        connectedAccountMaterializationAuthority: {
          kind: 'qualified', purposeBindings: [], requestAuthPurposeBindings: [],
        },
        qualifiedPurposeBindingSnapshot: { ...declaration!, bindings: [] },
        exactPurposeBindingSubjectId: 'linked-native-state-fixture',
        connectedAccountsOwner,
        processEnv: { [environmentKey]: nativeHome },
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'shared' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      };
      const first = await materializeConnectedServicesForSpawnProduction(params);
      expect(first).not.toBeNull();
      const home = first!.env[environmentKey]!;
      const expectedBinding = sourcePresent ? {
        agentId, pluginId: `happier.agent.${agentId}`,
        sourceCustody: runtimeFixture!.registry.readPluginSourceCustody!(`happier.agent.${agentId}`),
        nativeHomeRoot: await realpath(home),
        entries: [{ entryPath: stateEntry, sourceEntryRoot: await realpath(join(nativeHome, stateEntry)),
          materializedEntryPath: join(await realpath(home), stateEntry) }],
      } : undefined;
      expect(first!.materializedStateObservationBinding).toEqual(expectedBinding);
      const transcript = join(home, stateEntry, '-tmp', 's.jsonl');
      await mkdir(join(home, stateEntry, '-tmp'), { recursive: true });
      await writeFile(transcript, '{"sessionId":"s"}\n');
      if (!sourcePresent) {
        await expect(lstat(join(nativeHome, stateEntry))).rejects.toMatchObject({ code: 'ENOENT' });
        const foreignState = join(root, 'foreign-state');
        await mkdir(foreignState);
        await writeFile(join(foreignState, 'other.jsonl'), 'another account');
        await symlink(foreignState, join(home, stateEntry, 'foreign'), 'dir');
      }

      // The first launch remains live: refresh uses this same staged replacement owner.
      const refreshed = await materializeConnectedServicesForSpawnProduction(params);
      expect(refreshed!.env[environmentKey]).toBe(home);
      expect(refreshed!.materializedStateObservationBinding).toEqual(expectedBinding);
      expect(await readFile(transcript, 'utf8')).toBe('{"sessionId":"s"}\n');
      expect((await lstat(join(home, stateEntry))).isSymbolicLink()).toBe(sourcePresent);
      const manifest = await readConnectedServiceStateSharingManifest(home);
      expect(manifest.stateEntries.includes(stateEntry)).toBe(sourcePresent);
      if (sourcePresent) {
        expect(await realpath(join(home, stateEntry))).toBe(await realpath(join(nativeHome, stateEntry)));
        await writeFile(join(nativeHome, stateEntry, '-tmp', 's.jsonl'), '{"sessionId":"s","turn":2}\n');
      } else {
        await expect(lstat(join(nativeHome, stateEntry))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(join(home, stateEntry, 'foreign'))).rejects.toMatchObject({ code: 'ENOENT' });
        await writeFile(transcript, '{"sessionId":"s","turn":2}\n');
      }
      const nextRefresh = await materializeConnectedServicesForSpawnProduction(params);
      expect(await readFile(transcript, 'utf8')).toBe('{"sessionId":"s","turn":2}\n');
      await nextRefresh!.cleanupOnExit!();
      await refreshed!.cleanupOnExit!();
      await first!.cleanupOnExit!();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to import local state through an aliased previous materialized home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-aliased-run-native-state-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'aliased-run-native-state', activeServerDir: root,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => true,
      };
      const first = await materializeConnectedServicesForSpawnProduction(params);
      const home = first!.env.CODEX_HOME!;
      await rm(home, { recursive: true, force: true });
      const outside = join(root, 'outside');
      await mkdir(join(outside, 'sessions'), { recursive: true });
      await writeFile(join(outside, 'sessions', 'rollout.jsonl'), 'another native home');
      await symlink(outside, home, 'dir');
      await expect(materializeConnectedServicesForSpawnProduction(params)).rejects.toThrow('connected_service_materialization_root_unsafe');
      expect((await lstat(home)).isSymbolicLink()).toBe(true);
      expect(await readFile(join(outside, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('another native home');
    } finally {
      envScope.restore(); reloadConfiguration(); await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves isolated declared native state after Run custody ends and through rematerialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-ended-run-native-state-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'ended-run-native-state', activeServerDir: root,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => true,
      };
      const first = await materializeConnectedServicesForSpawnProduction(params);
      const home = first!.env.CODEX_HOME!;
      const archive = join(home, 'archived_sessions', 'rollout.jsonl');
      await mkdir(join(home, 'archived_sessions'), { recursive: true });
      await writeFile(archive, '{"nativeSession":"archived-thread"}\n');
      await first!.cleanupOnExit!();
      expect(await readFile(archive, 'utf8')).toContain('archived-thread');
      const second = await materializeConnectedServicesForSpawnProduction(params);
      await second!.cleanupOnExit!();
      expect(await readFile(archive, 'utf8')).toContain('archived-thread');
    } finally {
      envScope.restore(); reloadConfiguration(); await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { displacedPrefix: false, missingState: false },
    { displacedPrefix: true, missingState: false },
    { displacedPrefix: false, missingState: true },
  ])('prepares the retained thread after Stop and resume ($displacedPrefix prefix, $missingState missing)', async ({ displacedPrefix, missingState }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-retained-run-link-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const vendorResumeId = '019fea40-8040-7d00-9b7e-9b8f3b5cfca8';
      const rolloutName = `rollout-2026-09-07T12-00-00-${vendorResumeId}.jsonl`;
      const nativeHome = join(root, 'native');
      await mkdir(join(nativeHome, 'sessions'), { recursive: true });
      const record = buildConnectedServiceCredentialRecord({
        now: 10, serviceId: 'openai-codex', profileId: 'retained-account', kind: 'oauth', expiresAt: 100000,
        oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: null,
          scope: null, tokenType: null, providerAccountId: null, providerEmail: null },
      });
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'retained-review-run', activeServerDir: join(root, 'server'),
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map([['openai-codex', record]]),
        processEnv: { CODEX_HOME: nativeHome },
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'shared' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      };
      const published = await materializeConnectedServicesForSpawn(params);
      const home = published!.env.CODEX_HOME!;
      // The native process publishes its history through the shared entry.
      const metadata = `${JSON.stringify({ type: 'session_meta', payload: { id: vendorResumeId } })}\n`;
      const publishedHistory = `${metadata}${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Retained review' } })}\n`;
      await writeFile(join(home, 'sessions', rolloutName), publishedHistory);
      if (displacedPrefix) {
        const displaced = join(home, 'sessions.local-1700000000000');
        await mkdir(displaced);
        await writeFile(join(displaced, rolloutName), metadata);
      }
      await writeFile(join(nativeHome, 'sessions', 'unrelated-session.jsonl'), 'other conversation\n');
      await retainExecutionRunState({
        runId: params.materializationKey, callId: 'call', sidechainId: 'side', sessionId: 'parent', depth: 0,
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
        ioMode: 'streaming', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
        resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, providerSessionId: vendorResumeId },
      });
      await published!.cleanupOnExit!();
      if (missingState) await rm(join(nativeHome, 'sessions', rolloutName));
      const registry = new ConnectedServiceRuntimeRegistry();
      const { owner: purposeOwner } = createForegroundPurposeOwnerFixture({
        consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: record.profileId,
        materializeAccount: async input => await materializeExactV021ConnectedServiceCredential({
          registry: runtimeFixture!.registry, serviceId: 'openai-codex', account: input.account,
          record, request: input.request, signal: input.signal,
        }),
      });
      const bindings = { v: 2 as const, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: record.profileId },
      } };
      const credentials = { token: 'fixture-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
      const api = await ApiClient.create(credentials);
      const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
      const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
        ref: { service, accountId: record.profileId }, status: 'connected', authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        configurationReady: true, configurationRevision: null, kind: 'oauth', expiresAt: null, scopes: [],
      }] });
      const bridge = createExecutionRunConnectedServicesBridge({
        // Account credential retrieval is the external boundary; retain the
        // spawn auth gate, home, catalog, purpose owner and Run registry.
        resolveAuthForSpawn: input => resolveConnectedServiceAuthForSpawn({
          ...input, activeServerDir: params.activeServerDir, baseDir: params.baseDir,
          accountSettings: params.accountSettings, processEnv: params.processEnv,
          allowNativeAccountState: false, connectedAccountsOwner: purposeOwner, credentials, api,
          qualifiedConnectedAccountApi: {
            listAccounts: async () => accounts,
            readGroup: async () => { throw new Error('A profile-bound Run must not read a group'); },
          },
        }),
        registerRunTargets: registration => { registry.registerRunTarget({ ...registration, pid: registration.runnerPid,
          connectedServicesBindingsRaw: registration.connectedServicesBindingsRaw }); },
        unregisterRunTargets: runKey => registry.unregisterRunKey(runKey),
        resolveRunMaterializedRoot: () => home,
        createAdoptedRootCleanup: () => null,
        captureRunnerIdentity: () => ({ identity: params, parentSessionId: 'parent', isCurrent: () => true }),
        acquireAgentPurposeContributions: async () => ({
          contributions: runtimeFixture!.registry.contributes,
          catalogEntry: await runtimeFixture!.registry.acquireAgentCatalogEntry?.('codex'),
          resolveAgentContributionIdentity: async () => ({ pluginId: 'happier.agent.codex', localId: 'codex',
            sourceCustody: runtimeFixture!.registry.readPluginSourceCustody!('happier.agent.codex')! }),
          isCurrent: () => true, release: async () => undefined,
        }),
        purposeBindingOwner: { activatePurposeBindings: input => ({ lease: purposeOwner.activatePurposeBindings(input) }) },
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
        resolveRequestAuthHttpPort: () => 42427,
        createRedactionLease: () => ({ add() {}, close() {} }),
        clearTerminalCleanupReceipt: async () => undefined,
      });
      const activationId = randomUUID();
      const resumed = await bridge.materialize({ activationId, runId: params.materializationKey,
        runnerPid: process.pid, agentId: 'codex', connectedServices: bindings, cwd: root });
      if (missingState) {
        expect(resumed).toMatchObject({ ok: false, errorCode: 'connected_service_run_materialization_blocked' });
        expect(existsSync(join(nativeHome, 'sessions', 'unrelated-session.jsonl'))).toBe(true);
        return;
      }
      expect(resumed).toMatchObject({ ok: true, env: { CODEX_HOME: home } });
      expect((await lstat(join(home, 'sessions'))).isSymbolicLink()).toBe(false);
      expect(await readFile(join(home, 'sessions', rolloutName), 'utf8')).toBe(publishedHistory);
      expect(await verifyResumeReachableThroughCatalog('codex', { targetMaterializedRoot: home, vendorResumeId }))
        .toMatchObject({ ok: true });
      expect(existsSync(join(home, 'sessions', 'unrelated-session.jsonl'))).toBe(false);
      // The source remains available to its original owner.
      expect(await readFile(join(nativeHome, 'sessions', rolloutName), 'utf8')).toContain(vendorResumeId);
      await bridge.release({ activationId, runId: params.materializationKey, runnerPid: process.pid });
    } finally { envScope.restore(); reloadConfiguration(); await rm(root, { recursive: true, force: true }); }
  });

  it('preserves a Session home and its local rollout through exit and credential rematerialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-native-home-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'csm_retained-session', activeServerDir: root,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => true,
      };
      const first = await materializeConnectedServicesForSpawnProduction(params);
      const home = first!.env.CODEX_HOME!;
      // Immediate cleanup cannot establish absence of a server Session reference.
      await first!.cleanupOnExit!();
      expect(existsSync(home)).toBe(true);
      await mkdir(join(home, 'sessions'), { recursive: true });
      await writeFile(join(home, 'sessions', 'rollout.jsonl'), '{"nativeSession":"session-thread"}\n');
      const shared = join(root, 'shared-native-sessions');
      await mkdir(shared);
      await writeFile(join(shared, 'another-session.jsonl'), 'another account');
      await symlink(shared, join(home, 'sessions', 'shared'), 'dir');
      const second = await materializeConnectedServicesForSpawnProduction(params);
      await second!.cleanupOnExit!();
      expect(await readFile(join(home, 'sessions', 'rollout.jsonl'), 'utf8')).toContain('session-thread');
      await expect(lstat(join(home, 'sessions', 'shared'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      envScope.restore(); reloadConfiguration(); await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps isolated native rollout state on exit while its retained Run can resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-retained-run-native-home-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const runId = 'retained-isolated-run';
      const materialized = await materializeConnectedServicesForSpawnProduction({
        agentId: 'codex', materializationKey: runId, activeServerDir: root,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => true,
      });
      const rollout = join(materialized!.env.CODEX_HOME!, 'sessions', 'rollout.jsonl');
      await mkdir(join(materialized!.env.CODEX_HOME!, 'sessions'), { recursive: true });
      await writeFile(rollout, '{"nativeSession":"thread"}\n');
      await retainExecutionRunState({
        runId, callId: 'call', sidechainId: 'side', sessionId: null, depth: 0,
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable',
        runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
        resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, providerSessionId: 'thread' },
      });
      await materialized!.cleanupOnExit!();
      expect(await readFile(rollout, 'utf8')).toContain('thread');
      const resumed = await materializeConnectedServicesForSpawnProduction({
        agentId: 'codex', materializationKey: runId, activeServerDir: root,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => true,
      });
      expect(await readFile(rollout, 'utf8')).toContain('thread');
      await resumed!.cleanupOnExit!();
    } finally {
      envScope.restore(); reloadConfiguration(); await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes requester credentials without importing custodian native configuration or sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-requester-native-isolation-'));
    const nativeHome = join(root, 'alice-codex');
    await mkdir(join(nativeHome, 'sessions'), { recursive: true });
    await writeFile(join(nativeHome, 'config.toml'), 'model = "alice-private-model"\n');
    await writeFile(join(nativeHome, 'sessions', 'alice.jsonl'), '{"private":"Alice"}\n');
    const record = buildConnectedServiceCredentialRecord({ now: 10, serviceId: 'openai-codex', profileId: 'bob',
      kind: 'oauth', expiresAt: 123, oauth: { accessToken: 'bob-access', refreshToken: 'bob-refresh', idToken: 'bob-id',
        scope: 'openid profile', tokenType: 'Bearer', providerAccountId: 'bob', providerEmail: null } });
    let result: Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>> = null;
    try {
      const deniedRoot = resolveConnectedServiceMaterializedRootDir({ baseDir: join(root, 'denied-materialized'),
        agentId: 'codex', materializationKey: 'denied-bob-session' });
      await expect(materializeConnectedServicesForSpawn({ agentId: 'codex', materializationKey: 'denied-bob-session',
        activeServerDir: join(root, 'server'), baseDir: join(root, 'denied-materialized'),
        connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
        recordsByServiceId: new Map([['openai-codex', record]]), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => false,
      })).rejects.toThrow('requester_account_context_unavailable');
      expect(existsSync(deniedRoot)).toBe(false);
      result = await materializeConnectedServicesForSpawn({ agentId: 'codex', materializationKey: 'bob-session',
        activeServerDir: join(root, 'server'), baseDir: join(root, 'bob-materialized'),
        connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
        recordsByServiceId: new Map([['openai-codex', record]]), allowNativeAccountState: false,
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'linked', stateMode: 'shared' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } }, processEnv: { CODEX_HOME: nativeHome, HOME: root },
      });
      expect(result).not.toBeNull();
      const home = result!.env.CODEX_HOME!;
      expect(home).not.toBe(nativeHome);
      expect(await readFile(join(home, 'auth.json'), 'utf8')).toContain('bob-access');
      await expect(lstat(join(home, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(home, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(nativeHome, 'config.toml'), 'utf8')).toContain('alice-private-model');
    } finally {
      await result?.cleanupOnExit?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists the shared target materialized root for OpenCode continuity recovery', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const materializedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'opencode',
      materializationKey: 'session-opencode',
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'openid profile',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-opencode',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(
      materializedRoot,
    );
    expect(result!.requestAuthMaterializedRoot).toBeNull();
    expect(result!.env).not.toHaveProperty(
      'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH',
    );
    if (process.platform !== 'win32') {
      expect((await lstat(materializedRoot)).mode & 0o777).toBe(0o700);
    }
  });

  it('awaits promoted-root absence before the promoted spawn cleanup resolves', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const materializedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'opencode',
      materializationKey: 'session-cleanup-receipt',
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'openid profile',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-cleanup-receipt',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.cleanupOnExit).not.toBeNull();
    expect(existsSync(materializedRoot)).toBe(true);

    await result!.cleanupOnExit!();
    expect(existsSync(materializedRoot)).toBe(false);
    await expect(result!.cleanupOnExit!()).resolves.toBeUndefined();
  });

  it('retains destination Codex hook preferences when prior account context differs without linking hook definitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-hooks-rematerialize-'));
    try {
      const sourceCodexHome = join(root, 'native');
      await mkdir(sourceCodexHome, { recursive: true });
      const hooks = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo fixture"}]}]}}\n';
      await writeFile(join(sourceCodexHome, 'hooks.json'), hooks);
      await writeFile(join(sourceCodexHome, 'config.toml'), 'model_context_window = 9223372036854775807\n');
      const record = buildConnectedServiceCredentialRecord({
        now: 10, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: null,
        oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id',
          scope: null, tokenType: null, providerAccountId: 'fixture-account', providerEmail: null },
      });
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'hook-profile', activeServerDir: join(root, 'server'), baseDir: join(root, 'profiles'),
        connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
        recordsByServiceId: new Map([['openai-codex', record]]),
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'linked', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
        processEnv: { CODEX_HOME: sourceCodexHome, HOME: root },
      };
      const first = await materializeConnectedServicesForSpawn(params);
      expect(first).not.toBeNull();
      const home = first!.env.CODEX_HOME!;
      const hookId = `${join(home, 'hooks.json')}:stop:0:0`;
      expect((await lstat(join(home, 'hooks.json'))).isSymbolicLink()).toBe(false);
      await writeFile(join(home, 'config.toml'),
        (await readFile(join(home, 'config.toml'), 'utf8')) + `\n[hooks.state.'${hookId}']\nenabled = false\ntrusted_hash = 'sha256:reviewed'\n`);
      const priorHome = join(resolveConnectedServiceHomeDir({
        activeServerDir: params.activeServerDir, serviceId: 'openai-codex', profileId: 'another-account', agentId: 'codex',
      }), 'codex-home');
      await mkdir(priorHome, { recursive: true });
      const priorHookId = `${join(priorHome, 'hooks.json')}:stop:0:0`;
      await writeFile(join(priorHome, 'config.toml'), `[hooks.state.'${priorHookId}']\nenabled = true\ntrusted_hash = 'sha256:other-account'\n`);
      const nativeHookId = `${join(sourceCodexHome, 'hooks.json')}:stop:0:0`;
      await writeFile(join(sourceCodexHome, 'config.toml'),
        `model_context_window = 9223372036854775807\n[hooks.state.'${nativeHookId}']\nenabled = true\ntrusted_hash = 'sha256:native'\n`);
      await writeFile(join(sourceCodexHome, 'hooks.json'), '{"hooks":{"Stop":[]}}\n');
      await expect(readFile(join(home, 'hooks.json'), 'utf8')).resolves.toBe(hooks);
      const second = await materializeConnectedServicesForSpawn({ ...params, runtimeDescriptorV1: {
        v: 1, agentId: 'codex', agent: {
          backendMode: 'appServer', home: 'connectedService', homePath: priorHome,
          connectedServiceId: 'openai-codex', connectedServiceProfileId: 'another-account',
        },
      } });
      expect(second!.env.CODEX_HOME).toBe(home);
      const retained = await readFile(join(home, 'config.toml'), 'utf8');
      expect(retained).toContain(hookId);
      expect(retained).toContain('enabled = false');
      expect(retained).toContain('sha256:reviewed');
      expect(retained).not.toContain(priorHookId);
      expect(retained).not.toContain('sha256:other-account');
      expect(retained).not.toContain(nativeHookId);
      expect(retained).toContain('9223372036854775807');
      expect(retained).not.toContain('.stage-');
      await expect(readFile(join(home, 'hooks.json'), 'utf8')).resolves.toBe('{"hooks":{"Stop":[]}}\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('removes managed Codex home shares when settings are isolated', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-source-codex-home-test-'));
    await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.2-codex"\n');
    await mkdir(join(sourceCodexHome, 'prompts'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'prompts', 'review.md'), 'Review prompt\n');
    await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'sessions', 'rollout-shared.jsonl'), '{"id":"shared"}\n');
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const first = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([['openai-codex', record]]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            codex: {
              configMode: 'linked',
              stateMode: 'shared',
            },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
      processEnv: {
        CODEX_HOME: sourceCodexHome,
        HOME: tmpdir(),
      },
    });

    expect(first).not.toBeNull();
    const firstAuth = JSON.parse(await readFile(join(first!.env.CODEX_HOME!, 'auth.json'), 'utf8'));
    expect(firstAuth).toMatchObject({
      auth_mode: 'chatgptAuthTokens',
      access_token: 'access',
      refresh_token: '',
      tokens: { access_token: 'access', refresh_token: '' },
    });
    const copiedConfig = await readFile(join(first!.env.CODEX_HOME!, 'config.toml'), 'utf8');
    expect(copiedConfig).toContain('model = "gpt-5.2-codex"');
    expect(copiedConfig).toContain('cli_auth_credentials_store = "file"');
    await expect(readFile(join(first!.env.CODEX_HOME!, 'prompts', 'review.md'), 'utf8')).resolves.toBe('Review prompt\n');
    await expect(readFile(join(first!.env.CODEX_HOME!, 'sessions', 'rollout-shared.jsonl'), 'utf8')).resolves.toBe('{"id":"shared"}\n');

    const isolatedRecord = buildConnectedServiceCredentialRecord({
      now: 20,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'isolated-access',
        refreshToken: 'isolated-refresh',
        idToken: 'isolated-id',
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    // Simulate a predecessor-created materialized home before resume/replacement.
    await writeFile(join(first!.env.CODEX_HOME!, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'historical-access', refresh_token: 'historical-refresh' },
    }));
    await mkdir(join(first!.env.CODEX_HOME!, 'accounts'), { recursive: true });
    await writeFile(join(first!.env.CODEX_HOME!, 'accounts', 'old.json'), '{"refresh_token":"historical-refresh"}');

    const second = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([['openai-codex', isolatedRecord]]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            codex: {
              configMode: 'isolated',
              stateMode: 'isolated',
            },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
      processEnv: {
        CODEX_HOME: sourceCodexHome,
        HOME: tmpdir(),
      },
    });

    expect(second).not.toBeNull();
    const auth = JSON.parse(await readFile(join(second!.env.CODEX_HOME!, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('isolated-access');
    expect(auth).toMatchObject({
      auth_mode: 'chatgptAuthTokens',
      refresh_token: '',
      tokens: { access_token: 'isolated-access', refresh_token: '' },
    });
    // The rust-v0.162.1 file-auth backend owns auth.json, not this account-local
    // directory. The descriptor excludes it from sharing; a partial credential
    // projection must not turn that exclusion into ownership of private state.
    expect((await lstat(join(second!.env.CODEX_HOME!, 'accounts'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(second!.env.CODEX_HOME!, 'accounts', 'old.json'), 'utf8'))
      .toBe('{"refresh_token":"historical-refresh"}');
    await expect(lstat(join(second!.env.CODEX_HOME!, 'config.toml'))).rejects.toThrow();
    await expect(lstat(join(second!.env.CODEX_HOME!, 'prompts'))).rejects.toThrow();
    await expect(lstat(join(second!.env.CODEX_HOME!, 'sessions'))).rejects.toThrow();
  });

  it('materializes the exact-v0.2.1 OpenCode XDG auth file without probing the refresh token', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const codex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const claude = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'personal',
      kind: 'token',
      token: { token: 'sk-ant-123', providerAccountId: null, providerEmail: 'user@example.com' },
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('OAuth refresh must not be probed during materialization');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', codex],
        ['anthropic', claude],
      ]),
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.env.HOME).toBeTruthy();
    expect(result!.env.XDG_DATA_HOME).toBeTruthy();
    expect(result!.env.OPENCODE_TEST_HOME).toBe(result!.env.HOME);
    const auth = JSON.parse(await readFile(
      join(result!.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      'utf8',
    ));
    expect(auth).toEqual({
      openai: {
        type: 'oauth',
        refresh: 'refresh',
        access: 'access',
        expires: 123,
        accountId: 'acct',
      },
      anthropic: { type: 'api', key: 'sk-ant-123' },
    });
    expect(result!.env).not.toHaveProperty('HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH');
    expect(fetchMock).not.toHaveBeenCalled();

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
    vi.unstubAllGlobals();
  });

  it('materializes the exact-v0.2.1 OpenCode XDG auth file with OpenAI API key credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const openai = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2-openai',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.HOME).toBeTruthy();
    expect(result!.env.XDG_DATA_HOME).toBeTruthy();
    const auth = JSON.parse(await readFile(
      join(result!.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      'utf8',
    ));
    expect(auth).toEqual({
      openai: {
        type: 'api',
        key: 'sk-openai-test',
      },
    });
  });

  it('keeps OpenCode oauth materialization local when the network would reject the refresh token', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const codex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'stale-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({
        error: {
          message: 'Your refresh token has already been used to generate a new access token. Please try signing in again.',
          type: 'invalid_request_error',
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2-stale',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', codex],
      ]),
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(await readFile(
      join(result!.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      'utf8',
    )).toContain('stale-refresh');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('materializes exact-v0.2.1 Pi raw auth and Anthropic environment', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const codex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const claudeSetup = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-ant-123', providerAccountId: null, providerEmail: null },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'session-3',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', codex],
        ['anthropic', claudeSetup],
      ]),
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.env.PI_CODING_AGENT_DIR).toBe(
      join(resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'pi',
        materializationKey: 'session-3',
      }), 'pi-agent-dir'),
    );
    if (process.platform !== 'win32') {
      expect((await lstat(resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'pi',
        materializationKey: 'session-3',
      }))).mode & 0o777).toBe(0o700);
    }
    expect(result!.env.ANTHROPIC_API_KEY).toBe('sk-ant-123');

    const authPath = join(result!.env.PI_CODING_AGENT_DIR, 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toEqual({
      'openai-codex': {
        type: 'oauth',
        refresh: 'refresh',
        access: 'access',
        expires: 123,
        accountId: 'acct',
      },
    });
    expect(result!.env).not.toHaveProperty('HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH');

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
  });

  it('materializes Pi auth.json with OpenAI API key credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const openai = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'session-3-openai',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.PI_CODING_AGENT_DIR).toBe(
      join(resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'pi',
        materializationKey: 'session-3-openai',
      }), 'pi-agent-dir'),
    );

    const authPath = join(result!.env.PI_CODING_AGENT_DIR, 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toEqual({
      openai: {
        type: 'api_key',
        key: 'sk-openai-test',
      },
    });
  });

  it('does not export PI_CODING_AGENT_SESSION_DIR when Pi state sharing is enabled', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const openai = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'session-3-openai',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            pi: {
              stateMode: 'shared',
            },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result!.env).not.toHaveProperty('PI_CODING_AGENT_SESSION_DIR');
  });

  it('keeps Claude credentials isolated while reconciling configuration sharing independently of unchanged credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-source-claude-config-test-'));
    const setup = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-ant-oat01-123', providerAccountId: null, providerEmail: null },
    });
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"permissions":{"allow":["Bash(*)"]}}\n');

    const params = {
      agentId: 'claude',
      materializationKey: 'session-6a',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([['claude-subscription', setup]]),
      processEnv: {
        ...process.env,
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
      },
    } satisfies MaterializeParams;
    const result = await materializeConnectedServicesForSpawn(params);
    expect(result).not.toBeNull();
    expect(JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8'))).toEqual({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-123',
        scopes: ['user:inference'],
      },
    });
    expect(result!.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(result!.env).not.toHaveProperty('CLAUDE_CODE_SETUP_TOKEN');
    const target = result!.env.CLAUDE_CONFIG_DIR;
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(target, '.credentials.json'))).isSymbolicLink()).toBe(false);
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"updated"}\n');
    expect(JSON.parse(await readFile(join(target, 'settings.json'), 'utf8'))).toEqual({ theme: 'updated' });

    const copiedParams = {
      ...params,
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
        v: 1, defaults: { configMode: 'copied', stateMode: 'isolated' },
      } },
    } satisfies MaterializeParams;
    await materializeConnectedServicesForSpawn(copiedParams);
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(false);
    const copiedSettingsIdentity = await lstat(join(target, 'settings.json'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"refreshed"}\n');
    await materializeConnectedServicesForSpawn(copiedParams);
    if (process.platform !== 'win32') {
      expect((await lstat(join(target, 'settings.json'))).ino).toBe(copiedSettingsIdentity.ino);
    }
    expect(JSON.parse(await readFile(join(target, 'settings.json'), 'utf8'))).toEqual({ theme: 'refreshed' });

    await materializeConnectedServicesForSpawn({
      ...params,
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
        v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' },
      } },
    });
    await expect(lstat(join(target, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(target, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken)
      .toBe('sk-ant-oat01-123');
  });
});
