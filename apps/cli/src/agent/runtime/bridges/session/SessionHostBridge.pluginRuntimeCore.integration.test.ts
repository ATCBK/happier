import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createEphemeralPluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  SAMPLE_PLUGIN_BACKEND_ID,
  SAMPLE_PLUGIN_ID,
  materializeSamplePluginFixture,
} from '@/plugins/testkit/samplePackage';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { Credentials } from '@/persistence';

import { SessionHostBridge } from './SessionHostBridge';
import { createSessionAttachFile } from '@/daemon/sessionAttachFile';
import { createNativeSessionClientTestPort } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { resolveHostSessionRuntimeFactoryResult } from '@/agent/runtime/session/loop/factoryResult';
import type { HostSessionRuntimeHookRuntime } from '@/agent/runtime/session/loop/runHostSessionRuntime';

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

async function installSample(params: Readonly<{
  happyHomeDir: string;
  pluginRoot: string;
  trustPolicy: 'local_trusted' | 'prompt';
}>): Promise<void> {
  await materializeSamplePluginFixture(params.pluginRoot);
  await createPluginStateStore({ happyHomeDir: params.happyHomeDir }).write({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {
      [SAMPLE_PLUGIN_ID]: {
        source: {
          kind: 'path',
          locator: params.pluginRoot,
          trustPolicy: params.trustPolicy,
          installPolicy: 'link',
          resolvedPath: params.pluginRoot,
          manifestPath: join(params.pluginRoot, '.happier-plugin', 'plugin.json'),
        },
        compatibility: { status: 'unknown', diagnostics: [] },
        install: {
          mode: 'link',
          manifestVersion: '1.0.0',
          installedPath: null,
        },
        state: { enabled: true },
      },
    },
  });
}

afterEach(() => {
  envScope.restore();
  reloadConfiguration();
});

describe('SessionHostBridge current custom Agent (integration)', () => {
  it('uses an explicitly held Runner-local registry lease without consulting the daemon singleton', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-runner-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-runner-plugin-'));
    try {
      await installSample({ happyHomeDir, pluginRoot, trustPolicy: 'local_trusted' });
      const lease = createEphemeralPluginRuntimeRegistryLease(
        await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, generation: 1 }),
      );
      try {
        const plan = await new SessionHostBridge().createSessionRuntime(
          SAMPLE_PLUGIN_BACKEND_ID,
          {
            credentials: createTestCredentials(),
            directory: pluginRoot,
            happyHomeDir,
          },
          { pluginRuntimeRegistryLease: lease },
        );
        expect(plan.agentId).toBe(SAMPLE_PLUGIN_BACKEND_ID);
        expect(plan.config.createSessionRuntime).toBeTypeOf('function');
      } finally {
        await lease.release();
      }
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('creates and opens a native session through the generation-bound Agent runtime lease', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-current-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-current-plugin-'));
    try {
      await installSample({ happyHomeDir, pluginRoot, trustPolicy: 'local_trusted' });
      envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir, PATH: process.env.PATH ?? '' });
      reloadConfiguration();

      const plan = await new SessionHostBridge().createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
        credentials: createTestCredentials(),
        directory: pluginRoot,
        happyHomeDir,
      });
      expect(plan.agentId).toBe(SAMPLE_PLUGIN_BACKEND_ID);
      expect(plan.config.createSessionRuntime).toBeTypeOf('function');

      const runtime = await plan.config.createSessionRuntime?.({
        directory: pluginRoot,
        metadata: {},
        machineId: 'machine-plugin',
        session: { sessionId: 'happy-session-1' },
        transcriptSession: {},
        messageBuffer: {},
        mcpServers: {},
        permissionHandler: {},
        getPermissionMode: () => 'default',
        memoryRecallGuidanceEnabled: false,
      } as never);
      expect(runtime).toMatchObject({
        operations: {
          sendTurnPrompt: expect.any(Function),
          subscribeRuntimeEvents: expect.any(Function),
          resetOrDisposeRuntime: expect.any(Function),
        },
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it.each([false, true])('uses the host-owned Team credential preparation callback for a pinned plugin runtime (committed attach=%s)', async attached => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-team-credential-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-team-credential-plugin-'));
    const upstreamRequests: unknown[] = [];
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      upstreamRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ output_text: 'TEAM_BINDING_SENTINEL' }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing controlled upstream address');
    const upstreamUrl = `http://127.0.0.1:${address.port}/v1`;
    try {
      envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
      reloadConfiguration();
      const fixture = await createManagedRunLaunchFixture({ directory: pluginRoot, happyHomeDir });
      const lease = fixture.lease;
      const agentId = fixture.agentId;
      const identity = fixture.contributes.agentDefinitionsById.get(agentId)?.identity;
      if (!identity) throw new Error('Missing admitted external Agent identity');
      const prepareTeamCredentialProviderBinding = vi.fn(async () => ({
        providerBinding: {
          source: {
            kind: 'team_resource' as const,
            resourceId: 'resource-1',
            resourceRevision: 3,
          },
          model: { id: 'gpt-5.5', name: 'Team model' },
          upstream: {
            protocol: 'openai-responses',
            normalizedUrl: upstreamUrl,
            credential: 'apiKey' as const,
          },
          materialization: { v: 1 as const, kind: 'spawnEnv' as const },
        },
        environmentOverlay: [{
          name: 'RUN_PROVIDER_TOKEN',
          value: 'synthetic-consumer-token',
          source: 'provider' as const,
        }],
        additionalRedactionValues: ['synthetic-consumer-token'],
        cleanup: async () => {},
      }));
      const binding = { v: 1 as const, slot: { kind: 'provider_model' as const }, resourceId: 'resource-1',
        expectedResourceRevision: 3, deliveryMode: 'brokered' as const, teamId: 'team-1' };
      const attachFile = attached ? await createSessionAttachFile({ happySessionId: 'runner-session-1',
        payload: { v: 2, encryptionMode: 'plain', snapshot: { metadata: {}, metadataVersion: 0,
          agentState: null, agentStateVersion: 0, acceptedTeamCredentialBinding: binding } },
      }) : null;
      try {
        const plan = await new SessionHostBridge().createSessionRuntime(
          agentId,
          {
            credentials: createTestCredentials(),
            directory: pluginRoot,
            happyHomeDir,
            backendTarget: {
              kind: 'agent',
              identity,
            },
            ...(attachFile ? { existingSessionId: 'runner-session-1', sessionAttachFilePath: attachFile.filePath }
              : { teamCredentialBindings: [binding] }),
            modelSelection: {
              v: 1,
              updatedAt: 1,
              ref: {
                agentTargetKey: fixture.agentTargetKey,
                providerConnectionId: null,
                modelId: 'gpt-5.5',
              },
            },
          },
          {
            pluginRuntimeRegistryLease: lease,
            prepareTeamCredentialProviderBinding,
          },
        );

        const session = createNativeSessionClientTestPort('runner-session-1');
        const presentationLifetime = new AbortController();
        onTestFinished(() => presentationLifetime.abort());
        const presentation = createCurrentSessionPresentationHost({ session, signal: presentationLifetime.signal });
        const runtime = await plan.config.createSessionRuntime?.({
          directory: pluginRoot,
          metadata: {},
          machineId: 'runner-machine-1',
          session,
          currentSessionPresentation: presentation.bindCurrentSession,
          transcriptSession: {},
          messageBuffer: {},
          mcpServers: {},
          permissionHandler: { cancelByPluginTurn: async () => undefined },
          getPermissionMode: () => 'safe-yolo',
          memoryRecallGuidanceEnabled: false,
        } as never);

        expect(runtime).toMatchObject({
          operations: {
            sendTurnPrompt: expect.any(Function),
            resetOrDisposeRuntime: expect.any(Function),
          },
        });
        if (!runtime) throw new Error('Expected the created host runtime');
        const resolved = resolveHostSessionRuntimeFactoryResult(runtime);
        const hookRuntime = (resolved.nativeRuntime ?? resolved.runtime) as HostSessionRuntimeHookRuntime;
        const operations = (runtime as Readonly<{ operations: Readonly<{
          sendTurnPrompt(prompt: string, input: Readonly<{
            turnId: string;
            localId: string;
            userMessageSeq: number;
          }>): Promise<void>;
          subscribeRuntimeEvents(listener: (event: Readonly<{ kind?: string; turnId?: string }>) => void): (() => void) | void;
          resetOrDisposeRuntime(): Promise<void>;
        }> }>).operations;
        const events: Readonly<{ kind?: string; turnId?: string }>[] = [];
        const unsubscribe = operations.subscribeRuntimeEvents((event) => events.push(event));
        await operations.sendTurnPrompt('brokered turn through external plugin', {
          turnId: 'runner-external-turn-1',
          localId: 'runner-external-input-1',
          userMessageSeq: 1,
        });
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'input-accepted',
          delivery: { kind: 'newTurn', turnId: 'runner-external-turn-1' },
        }));
        expect(upstreamRequests).toEqual([{ model: 'gpt-5.5', input: 'brokered turn through external plugin' }]);
        await expect(hookRuntime.prepareRunTeamCredentialProviderBinding?.({
          runId: 'run-1',
          agentId,
          resourceId: 'resource-1',
          modelId: 'gpt-5.5',
        })).resolves.toMatchObject({
          providerBinding: {
            source: { kind: 'team_resource', resourceId: 'resource-1', resourceRevision: 3 },
          },
        });
        expect(prepareTeamCredentialProviderBinding).toHaveBeenLastCalledWith({
          sessionId: 'runner-session-1',
          resourceId: 'resource-1',
          expectedResourceRevision: 3,
          agentTargetKey: fixture.agentTargetKey,
          modelId: 'gpt-5.5',
          consumer: { kind: 'execution_run', executionRunId: 'run-1' },
          executionRunAgentId: agentId,
          signal: expect.any(AbortSignal),
        });
        // An attached Run that independently selected a direct resource for
        // another Agent opens its own selection for its own Agent.
        await hookRuntime.prepareRunTeamCredentialProviderBinding?.({
          runId: 'run-direct',
          agentId: 'run-agent',
          resourceId: 'resource-direct',
          modelId: 'direct-model',
          selection: {
            kind: 'team_credential_provider_model',
            resourceId: 'resource-direct',
            teamId: 'team-direct',
            expectedResourceRevision: 9,
            deliveryMode: 'direct',
            agentTargetKey: 'agent:other.plugin/run-agent' as never,
            modelId: 'direct-model' as never,
          },
        });
        expect(prepareTeamCredentialProviderBinding).toHaveBeenLastCalledWith({
          sessionId: 'runner-session-1',
          resourceId: 'resource-direct',
          expectedResourceRevision: 9,
          agentTargetKey: 'agent:other.plugin/run-agent',
          modelId: 'direct-model',
          consumer: { kind: 'execution_run', executionRunId: 'run-direct' },
          executionRunSelection: { teamId: 'team-direct', deliveryMode: 'direct' },
          executionRunAgentId: 'run-agent',
          signal: expect.any(AbortSignal),
        });
        unsubscribe?.();
        await operations.resetOrDisposeRuntime();
        presentationLifetime.abort();
        expect(prepareTeamCredentialProviderBinding).toHaveBeenCalledWith({
          sessionId: 'runner-session-1',
          resourceId: 'resource-1',
          expectedResourceRevision: 3,
          agentTargetKey: fixture.agentTargetKey,
          modelId: 'gpt-5.5',
          signal: expect.any(AbortSignal),
        });
        if (attachFile) await expect(import('node:fs/promises').then(fs => fs.stat(attachFile.filePath))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await attachFile?.cleanup();
        await fixture.cleanup();
      }
    } finally {
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('fails before runtime creation when the current Agent plugin still requires trust approval', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-session-bridge-prompt-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-session-bridge-prompt-plugin-'));
    try {
      await installSample({ happyHomeDir, pluginRoot, trustPolicy: 'prompt' });
      envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir, PATH: process.env.PATH ?? '' });
      reloadConfiguration();

      await expect(new SessionHostBridge().createSessionRuntime(SAMPLE_PLUGIN_BACKEND_ID, {
        credentials: createTestCredentials(),
        directory: pluginRoot,
        happyHomeDir,
      })).rejects.toThrow(/trust approval/i);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });
});
