import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createRunnerAgentSessionBootstrapAuthorization } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { readRunnerAgentSessionBootstrap } from '@/agent/runtime/session/process/runnerAgentSessionBootstrap';
import { materializeExactV021ConnectedServiceCredential } from '../compatibility/exactV021ConnectedServiceMaterialization';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';

/** Real daemon materialization and protected runner carrier over synthetic Account credentials. */
export async function withCodexDaemonMaterializedBootstrap<T>(input: Readonly<{
  sessionId: string;
  bound: boolean;
  run(value: Readonly<{
    bootstrap: Awaited<ReturnType<typeof readRunnerAgentSessionBootstrap>>;
    environment: Readonly<Record<string, string>>;
    nativeHome: { root: string; readFiles(): Promise<Readonly<Record<string, Uint8Array>>> };
  }>): Promise<T>;
}>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'codex-daemon-binding-'));
  const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
  const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'codex', contributions: runtime.registry.contributes })!;
  const service = declaration.fileMaterializationPurposes[0]!.serviceRefs[0]!;
  const record = buildConnectedServiceCredentialRecord({ now: 10, serviceId: 'openai-codex', profileId: 'account-A',
    kind: 'oauth', expiresAt: null, oauth: { accessToken: 'synthetic-startup-A', refreshToken: 'synthetic-refresh',
      idToken: null, scope: null, tokenType: null, providerAccountId: 'provider-account-A', providerEmail: null } });
  const account = createForegroundPurposeOwnerFixture({ consumer: declaration.purposes[0]!.consumer, service, accountId: 'account-A',
    materializeAccount: async value => await materializeExactV021ConnectedServiceCredential({ registry: runtime.registry,
      serviceId: 'openai-codex', account: value.account, record, request: value.request, signal: value.signal }) });
  const bindings = input.bound ? [account.binding] : [];
  const lease = account.owner.activateSessionPurposeBindings({ sessionId: input.sessionId, purposes: declaration.purposes, bindings });
  let materialized: Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>> = null;
  let issued: Awaited<ReturnType<typeof createRunnerAgentSessionBootstrapAuthorization>> | undefined;
  try {
    materialized = await materializeConnectedServicesForSpawn({ agentId: 'codex', materializationKey: input.sessionId,
      purposeBindingSessionId: input.sessionId, activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'),
      recordsByServiceId: new Map(), connectedAccountsOwner: account.owner,
      ...(input.bound ? { connectedAccountMaterializationAuthority: { kind: 'qualified' as const, purposeBindings: bindings, requestAuthPurposeBindings: [] },
        qualifiedPurposeBindingSnapshot: { ...declaration, bindings },
        selectionsByServiceId: new Map([['happier.agent.codex/openai-codex', {
          kind: 'profile' as const, serviceId: 'happier.agent.codex/openai-codex', profileId: 'account-A',
        }]]) } : {}), processEnv: { CODEX_HOME: join(root, 'native') },
      allowNativeAccountState: false, sessionDirectory: root });
    if (!materialized) throw new Error('The real daemon materializer did not prepare a native home');
    const descriptor = await resolveRunnerAgentSessionDescriptorForLease({ target: { kind: 'backend', backendId: 'codex' }, lease: runtime.lease });
    if (!descriptor) throw new Error('The admitted Codex descriptor is unavailable');
    issued = await createRunnerAgentSessionBootstrapAuthorization({ happyHomeDir: root, publicReleaseRing: 'stable', descriptor,
      launch: { runtimeDescriptorV1: { v: 1, agentId: descriptor.agentId, agent: {} },
        ...(materialized.sessionConnectedAccounts ? { sessionConnectedAccounts: [...materialized.sessionConnectedAccounts] } : {}) } });
    const bootstrap = await readRunnerAgentSessionBootstrap(issued.authorization.bootstrapFilePath);
    const home = materialized.env.CODEX_HOME!;
    return await input.run({ bootstrap, environment: materialized.env, nativeHome: { root: home,
      readFiles: async (): Promise<Readonly<Record<string, Uint8Array>>> => input.bound
        ? { 'auth.json': await readFile(join(home, 'auth.json')) } : {} } });
  } finally {
    await issued?.cleanupBootstrapFile();
    await materialized?.cleanupOnExit?.();
    lease.dispose();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
