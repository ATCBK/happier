import { describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord, StrictJsonValueSchema } from '@happier-dev/protocol';
import { startCodexAppServerRuntime } from './runtime.js';
import { withCodexNativeAttachFixture as withFixture } from './runtime.nativeAttach.test-support.js';

describe('native Codex attachment preparation', () => {
  it.each([
    { initialProviderBinding: { v: 1 as const, modelProvider: 'ollama', config: {} } },
    { processEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId: 'openai-codex', profileId: 'fixture' }]) } },
  ])('refuses a model catalog from another provider or Connected Account authority before startup', async (externalAuthority) => {
    await withFixture(async ({ runtime, requests }) => {
      await expect(runtime.prepareProviderCliAttach()).rejects.toMatchObject({ code: 'codex_tool_restriction_unsupported_auth' });
      expect(requests.some(request => request.method === 'thread/start')).toBe(false);
    }, {
      ...externalAuthority,
      toolRestriction: { unlistedTools: 'deny', allowedTools: ['mcp__wilson__allowed_echo'] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
    });
  });
  it('refuses external account changes before native login can invalidate the tool-mode evidence', async () => {
    await withFixture(async ({ runtime, requests }) => {
      const credential = buildConnectedServiceCredentialRecord({
        now: 1000, serviceId: 'openai-codex', profileId: 'fixture', kind: 'oauth', expiresAt: 2000,
        oauth: { accessToken: 'fixture', refreshToken: 'fixture', idToken: 'fixture', scope: null, tokenType: null,
          providerAccountId: 'fixture', providerEmail: 'fixture@example.test' },
      });
      await expect(runtime.runtimeAuth.apply({ serviceId: 'openai-codex', authGeneration: { credential: StrictJsonValueSchema.parse(credential) } }))
        .rejects.toMatchObject({ code: 'codex_tool_restriction_unsupported_auth' });
      expect(requests.some(request => request.method === 'account/login/start')).toBe(false);
    }, {
      toolRestriction: { unlistedTools: 'deny', allowedTools: ['mcp__wilson__allowed_echo'] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
    });
  });
  it.skipIf(process.platform === 'win32')('preserves the safe typed tool-policy refusal through native startup sanitization', async () => {
    await withFixture(async ({ openConfiguredSession }) => {
      await expect(openConfiguredSession()).rejects.toMatchObject({ code: 'codex_tool_restriction_unsupported_model' });
    }, {
      nativeToolMode: 'direct',
      toolRestriction: { unlistedTools: 'deny', allowedTools: ['mcp__wilson__allowed_echo'] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
    });
  });
  it.skipIf(process.platform === 'win32')('rejects a direct-tool model update before applying it to a confined MCP session', async () => {
    await withFixture(async ({ runtime, requests }) => {
      await expect(runtime.updateConfig?.({ modelId: 'direct-model' })).rejects.toMatchObject({
        code: 'codex_tool_restriction_unsupported_model',
      });
      expect(requests.some(request => request.method === 'turn/start')).toBe(false);
    }, {
      toolRestriction: { unlistedTools: 'deny', allowedTools: ['mcp__wilson__allowed_echo'] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
    });
  });
  it.skipIf(process.platform === 'win32')('launches the shared native server with the frozen recipe and canonical filtered MCP catalog', async () => {
    await withFixture(async ({ openConfiguredSession, nativeLaunches }) => {
      await openConfiguredSession();
      expect(nativeLaunches[0]).toEqual(expect.arrayContaining([
        'features.shell_tool=false', 'features.view_image=false', 'web_search="disabled"',
        'mcp_servers.happier__wilson.enabled_tools=["allowed_echo"]',
        'mcp_servers.happier__wilson.default_tools_approval_mode="approve"',
      ]));
    }, {
      toolRestriction: { unlistedTools: 'deny', allowedTools: ['mcp__wilson__allowed_echo'] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
    });
  });
  it('retains confinement when a live configuration update requests unrestricted native permissions', async () => {
    await withFixture(async ({ runtime, requests }) => {
      await runtime.updateConfig?.({ permissionMode: 'yolo' });
      await runtime.prepareProviderCliAttach();
      const nativePolicy = requests.find((request) => request.method === 'thread/start')?.params;
      expect([':read-only', 'read-only']).toContain(nativePolicy?.permissions ?? nativePolicy?.sandbox);
      if (!nativePolicy?.permissions) expect(nativePolicy?.approvalPolicy).toBe('never');
    }, { toolRestriction: { unlistedTools: 'deny', allowedTools: [] } });
  });
  it.skipIf(process.platform === 'win32')('starts through native control with a long host temporary directory', async () => {
    await withFixture(async ({ openConfiguredSession }) => {
      const session = await openConfiguredSession();
      const presentation = await session.prepareTerminalPresentation?.();
      expect(presentation).toMatchObject({
        kind: 'provider_attach',
        metadata: { runtimeDescriptorV1: { agent: { providerSessionId: 'fresh-thread' } } },
      });
    }, { longTemporaryDirectory: true });
  });
  it.skipIf(process.platform === 'win32')('carries a safe typed startup rejection without provider text or tokens', async () => {
    await withFixture(async ({ openConfiguredSession, failResume }) => {
      failResume('provider refused startup: Bearer private-startup-token /private/config');
      const error = await openConfiguredSession('existing-thread').catch((failure: unknown) => failure);
      expect(error).toMatchObject({ name: 'CodexAppServerStartupError', code: 'agent_startup_rpc_rejected' });
      expect(String(error)).not.toContain('private-startup-token');
      expect(String(error)).not.toContain('/private/config');
      expect(JSON.stringify(error)).not.toContain('private-startup-token');
    });
  });
  it.each([
    ['no rollout found for thread id missing-thread', 'AGENT_RESUME_PROVIDER_STATE_MISSING'],
    ['provider temporarily unavailable', undefined],
  ])('classifies resume rejection %s without starting a replacement thread', async (message, code) => {
    await withFixture(async ({ runtime, requests, failResume }) => {
      failResume(message);
      const error = await startCodexAppServerRuntime(runtime, {
        resumeId: 'missing-thread', preserveRequestedThreadId: true,
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { code?: unknown }).code).toBe(code ?? -32000);
      expect(requests.filter((request) => request.method === 'thread/resume').map((request) => request.params.threadId))
        .toEqual(['missing-thread']);
      expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    });
  });
  it.skipIf(process.platform === 'win32')('preserves the typed missing-state reason through native session startup sanitization', async () => {
    await withFixture(async ({ openConfiguredSession, requests, failResume }) => {
      failResume('no rollout found for thread id missing-thread');
      const error = await openConfiguredSession('missing-thread').catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'AGENT_RESUME_PROVIDER_STATE_MISSING' });
      expect(requests.filter((request) => request.method === 'thread/resume').map((request) => request.params.threadId))
        .toEqual(['missing-thread']);
      expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    });
  });
  it.skipIf(process.platform === 'win32')('applies initial canonical effort before startup instructions initialize the native attachment thread', async () => {
    await withFixture(async ({ openConfiguredSession, requests }) => {
      const session = await openConfiguredSession();
      await session.prepareTerminalPresentation?.();
      expect(requests.find((r) => r.method === 'thread/start')?.params).toMatchObject({
        model: 'fixture-model', permissions: ':read-only',
        config: { model_reasoning_effort: 'low' },
        developerInstructions: 'Actual startup instructions.',
      });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
    });
  });
  it('materializes zero-turn fresh threads once and preserves identity and policy on repeat attach', async () => {
    await withFixture(async ({ runtime, requests, resume }) => {
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(runtime.identity.read()).toEqual({ providerSessionId: 'fresh-thread' });
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] }, sandbox: { type: 'readOnly' }, reasoningEffort: 'low' });
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/name/set')).toEqual([{ method: 'thread/name/set', params: { threadId: 'fresh-thread', name: 'Happier session actual-happier-session' } }]);
      expect(requests.filter((r) => r.method === 'thread/read')).toEqual([{ method: 'thread/read', params: { threadId: 'fresh-thread', includeTurns: true } }]);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
      expect(requests.find((r) => r.method === 'thread/start')?.params).toMatchObject({ permissions: ':read-only', config: { model_reasoning_effort: 'low' } });
      await runtime.updateConfig?.({ modelId: 'later-model' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      await runtime.updateConfig?.({ permissionMode: 'acceptEdits' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
    });
  });

  it('keeps an existing resumed thread name and does not initialize a new thread', async () => {
    await withFixture(async ({ runtime, requests }) => {
      await startCodexAppServerRuntime(runtime, { resumeId: 'existing-thread', importHistory: false });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('existing-thread');
      expect(requests.filter((r) => ['thread/start', 'thread/name/set', 'thread/read', 'turn/start'].includes(r.method))).toEqual([]);
    });
  });

  it('materializes a realtime-published zero-turn thread before native resume without replacing its identity', async () => {
    await withFixture(async ({ runtime, requests, resume }) => {
      await startCodexAppServerRuntime(runtime);
      const started = await runtime.realtimeConversation.start({ transport: { kind: 'webrtc', offerSdp: 'offer' } });
      expect(started.status).toBe('started');
      if (started.status !== 'started') throw new Error('Realtime fixture failed to start');
      expect(runtime.identity.read()).toEqual({ providerSessionId: 'fresh-thread' });
      await expect(resume()).rejects.toThrow('no rollout found');

      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/name/set')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/read')).toHaveLength(1);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
      await started.handle.stop();
      await runtime.updateConfig?.({ modelId: 'later-model' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/read')).toHaveLength(1);
    });
  });

  it('withholds attachment identity if the fresh rollout cannot be materialized', async () => {
    await withFixture(async ({ runtime, failRead }) => {
      failRead();
      await expect(runtime.prepareProviderCliAttach()).rejects.toThrow('rollout persistence failed');
      expect(runtime.identity.read()).toEqual({ providerSessionId: null });
    });
  });
});
