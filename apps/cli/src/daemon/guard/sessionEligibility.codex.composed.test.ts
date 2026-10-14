import { expect, it, vi } from 'vitest';
import axios from 'axios';
import { openCodexNativeAppServerSession } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/native';
import { withCodexNativeAttachFixture } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { createSessionOwnerMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createNativeAgentRuntimeSessionPlanFixture, createNativeSessionClientTestPort, createExternalContributionFixtures,
  createSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { withHostSessionRuntimeIdentityPublication } from '@/agent/runtime/identity/publication/withHostSession';
import { subscribeSessionRuntimePublicationToMetadata } from '@/agent/runtime/identity/metadata/subscription';
import { createCliRuntimeSessionStateBridge } from '@/agent/runtime/state/bridge';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { buildInactiveSessionResumeSpawnOptions } from '../sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { prepareExecuteSpawnSessionRequest } from '../startup/prepareExecuteSpawnSessionRequest';
import { evaluateSessionEligibility } from './sessionEligibility';
import type { TrackedSession } from '../types';

it.skipIf(process.platform === 'win32')('persists the real fresh Codex native open descriptor through the host plan and admits the same inactive Session', async () => {
  const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
  try {
    await withCodexNativeAttachFixture(async ({ exec, directory }) => {
      const sessionId = 'codex-resume-proof';
      const credentials = { token: 'codex-resume-proof', encryption: null };
      const contribution = createExternalContributionFixtures('codex');
      await fixture.registry.acquireAgentCatalogEntry?.('codex');
      const agent = fixture.registry.contributes.agentDefinitionsById.get('codex');
      const lease = fixture.registry.agentRuntimesByAgentId.get('codex');
      if (!agent || !lease) throw new Error('Admitted Codex declaration unavailable');
      const session = createNativeSessionClientTestPort(sessionId);
      await session.updateMetadata(metadata => ({ ...metadata, path: directory, machineId: 'machine-1', flavor: 'codex' }));
      const nativePlan = await createNativeAgentRuntimeSessionPlanFixture({
        runtime: { sessions: { open: openCodexNativeAppServerSession } },
        lease, backend: contribution.backend, agent,
        createSessionHostServiceOwners,
        // The process/native IPC boundary is the canonical Codex socket fixture.
        createInvocationServices: async () => ({ ...createUnavailablePluginServices(), exec }),
        sessionInput: buildPluginSessionBindingInput({ credentials, directory,
          backendTarget: { kind: 'backend', backendId: 'codex' },
          environmentVariables: { CODEX_HOME: directory },
          agentSessionStartupInstructionsV1: { v: 1, id: 'resume-proof', revision: 1, instructions: 'Reply without using tools.' },
        }),
      });
      const plan = withHostSessionRuntimeIdentityPublication({ plan: nativePlan,
        identity: { runtimeDescriptor: null, runtimeCapabilities: null, runtimeFacets: null } });
      const created = await plan.config.createSessionRuntime?.({ directory, machineId: 'machine-1',
        metadata: session.getMetadataSnapshot(), session, transcriptSession: {}, messageBuffer: {}, mcpServers: {},
        permissionHandler: { cancelByPluginTurn: async () => undefined }, getPermissionMode: () => 'read-only',
        memoryRecallGuidanceEnabled: false,
      } as never);
      if (!created) throw new Error('Native host factory unavailable');
      try {
        const metadata = session.getMetadataSnapshot();
        expect(RuntimeDescriptorV1Schema.parse(metadata.runtimeDescriptorV1)).toMatchObject({
          v: 1, agentId: 'codex', agent: { backendMode: 'appServer' },
        });
        const owner = createSessionOwnerMetadataV1({ metadata });
        expect(owner.ok).toBe(true);
        if (!owner.ok) throw new Error('Native descriptor rejected by owner persistence schema');
        SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata);
        // Native identity and descriptor reach the real state engine; only its Home persistence port is substituted.
        const state = createCliRuntimeSessionStateBridge({ credentials, session,
          metadataPort: { update: async (_id, updater) => {
            await session.updateMetadata(current => updater(current));
            return { ok: true, version: 1 };
          } },
        });
        const unsubscribe = subscribeSessionRuntimePublicationToMetadata({ session: session as never,
          sessionState: state.engine, runtime: created.operations, providerSessionMetadataKey: 'codexSessionId' });
        await vi.waitFor(() => expect(session.getMetadataSnapshot().codexSessionId).toBe('fresh-thread'));
        unsubscribe();
        const persisted = session.getMetadataSnapshot();
        const rawSession = { ...createSessionNotificationContextFixture(sessionId), machineId: 'machine-1', path: directory,
          encryptionMode: 'plain' as const, metadata: JSON.stringify(persisted) };
        const options = buildInactiveSessionResumeSpawnOptions({ sessionId, rawSession, metadata: persisted });
        expect(options).toMatchObject({ resume: 'fresh-thread', runtimeDescriptorV1: metadata.runtimeDescriptorV1 });
        if (!options) throw new Error('Persisted native open is not resumable');
        // Only Home HTTP is substituted. Identity, decryption, snapshot and native resume admission stay real.
        const http = vi.spyOn(axios, 'get').mockImplementation(async input => {
          const url = new URL(String(input));
          if (url.pathname === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: rawSession } };
          if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
          throw new Error(`Unexpected Home request: ${url.pathname}`);
        });
        try {
          const admitted = await runWithServerHttpBaseUrl('https://codex-resume.example', () => prepareExecuteSpawnSessionRequest({
            request: { options, credentials }, validateEnvVarRecordStrict,
          }));
          expect(admitted).toMatchObject({ effectiveResume: 'fresh-thread', runtimeDescriptorV1: metadata.runtimeDescriptorV1 });
        } finally { http.mockRestore(); }
      } finally { await created.operations.resetOrDisposeRuntime(); }
    });
  } finally { await fixture.dispose(); }
});

it('keeps a descriptor-less Codex Session that inactive admission cannot resume', async () => {
  const tracked: TrackedSession = { pid: 42, happySessionId: 'session-1', startedBy: 'daemon' };
  const resume = { sessionId: 'session-1', rawSession: { machineId: 'machine-1', path: '/project' },
    metadata: { machineId: 'machine-1', path: '/project', flavor: 'codex', codexSessionId: 'native-1' } };
  const inventory = { coverage: 'complete' as const, items: (['session', 'input', 'agents', 'attention'] as const).map(category => ({
    category, ownerRef: tracked, attribution: { kind: 'unknown' as const }, state: 'settled' as const, settledAt: 20,
  })) };
  expect(await evaluateSessionEligibility({ tracked, inventory, draft: { status: 'absent' }, resume }))
    .toMatchObject({ eligible: false, reasons: [{ kind: 'not_resumable' }] });
});
