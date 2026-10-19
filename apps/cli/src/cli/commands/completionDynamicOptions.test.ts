import { describe, expect, it, vi } from 'vitest';

import { resolveActionDynamicOptionsForCliCompletion } from './completionDynamicOptions';
import { resolveActionDefinitionForCliCompletion } from './actions';

describe('CLI dynamic Action completion', () => {
  it('discovers a contributed definition through the canonical get Action', async () => {
    const definition = {
      kindVersion: 1 as const,
      id: 'example.plugin/actions/ping',
      title: 'Ping',
      description: null,
      safety: 'safe' as const,
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: true, rpc: false, api: true, plugin: true },
      inputHints: null,
      inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
    };
    const execute = vi.fn(async () => ({ ok: true as const, result: { actionSpec: definition } }));

    await expect(resolveActionDefinitionForCliCompletion('example.plugin/actions/ping', [], {
      readCredentialsFn: async () => ({ token: 'hap_v1.test', encryption: null, credentialProvenance: 'stored_session' }),
      createExecutorFn: () => ({ execute, resolveSessionTarget: vi.fn() }),
    })).resolves.toEqual(definition);
    expect(execute).toHaveBeenCalledWith(
      'action.spec.get',
      { id: 'example.plugin/actions/ping', includeOutputSchema: true },
      expect.objectContaining({ surface: 'cli' }),
    );
  });

  it('binds contributed definition completion to the explicitly selected Home', async () => {
    const definition = {
      kindVersion: 1 as const,
      id: 'example.plugin/actions/ping',
      title: 'Ping',
      description: null,
      safety: 'safe' as const,
      placements: [], slash: null, bindings: null, examples: null,
      surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: true, rpc: false, api: true, plugin: true },
      inputHints: null,
      inputSchema: { type: 'object' },
    };
    const execute = vi.fn(async () => ({ ok: true as const, result: { actionSpec: definition } }));
    const readCredentialsFn = vi.fn();
    const readCredentialsForServerIdFn = vi.fn(async () => ({ token: 'home-b-token', encryption: null, credentialProvenance: 'stored_session' as const }));
    const createExecutorFn = vi.fn(() => ({ execute, resolveSessionTarget: vi.fn() }));

    await expect(resolveActionDefinitionForCliCompletion(
      'example.plugin/actions/ping',
      ['actions', 'invoke', 'example.plugin/actions/ping', '--server-id', 'profile-b'],
      {
        readCredentialsFn,
        readCredentialsForServerIdFn,
        getServerProfileFn: async () => ({
          id: 'profile-b', name: 'B', serverUrl: 'https://b.example', webappUrl: 'https://b.example',
          createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        }),
        createExecutorFn: createExecutorFn as any,
      },
    )).resolves.toEqual(definition);
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(readCredentialsForServerIdFn).toHaveBeenCalledWith('profile-b');
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'home-b-token' }),
      serverId: 'profile-b',
      serverApiUrl: 'https://b.example',
    }));
  });

  it('resolves the Session once and returns option values from the canonical Action', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: {
        options: [
          { value: 'codex', label: 'Codex' },
          { value: 'agent:acme.plugin/custom', label: 'Custom' },
        ],
      },
    }));
    const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'session_exact' }));

    await expect(resolveActionDynamicOptionsForCliCompletion({
      actionId: 'execution.run.start',
      fieldPath: 'agent',
      optionsSourceId: 'execution.backends.enabled',
      draftInput: { sessionId: 'work' },
      query: 'co',
      committedArgv: ['session_ignored_here', '--agent'],
      acceptsServerId: false,
    }, {
      readCredentialsFn: async () => ({ token: 'hap_v1.test', encryption: null, credentialProvenance: 'stored_session' }),
      createExecutorFn: () => ({ execute, resolveSessionTarget }),
    })).resolves.toEqual(['codex', 'agent:acme.plugin/custom']);

    expect(resolveSessionTarget).toHaveBeenCalledWith('work');
    expect(execute).toHaveBeenCalledWith('action.options.resolve', {
      actionId: 'execution.run.start',
      fieldPath: 'agent',
      optionsSourceId: 'execution.backends.enabled',
      draftInput: { sessionId: 'session_exact' },
      query: 'co',
      sessionId: 'session_exact',
    }, {
      surface: 'cli',
      defaultSessionId: 'session_exact',
    });
  });

  it('binds dynamic choices and Session resolution to the explicitly selected Home', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: { options: [{ value: 'codex', label: 'Codex' }] },
    }));
    const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'session_on_b' }));
    const readCredentialsFn = vi.fn();
    const readCredentialsForServerIdFn = vi.fn(async () => ({
      token: 'home-b-token',
      encryption: null,
      credentialProvenance: 'stored_session' as const,
    }));
    const createExecutorFn = vi.fn(() => ({ execute, resolveSessionTarget }));

    await expect(resolveActionDynamicOptionsForCliCompletion({
      actionId: 'execution.run.start',
      fieldPath: 'agent',
      optionsSourceId: 'execution.backends.enabled',
      draftInput: { sessionId: 'same-session-id' },
      query: 'co',
      committedArgv: [
        'same-session-id',
        '--server-id',
        'profile-b',
        '--agent',
      ],
      acceptsServerId: true,
    }, {
      readCredentialsFn,
      readCredentialsForServerIdFn,
      getServerProfileFn: async () => ({
        id: 'profile-b', name: 'B', serverUrl: 'https://b.example', webappUrl: 'https://b.example',
        createdAt: 1, updatedAt: 1, lastUsedAt: 1,
      }),
      createExecutorFn: createExecutorFn as any,
    })).resolves.toEqual(['codex']);

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(readCredentialsForServerIdFn).toHaveBeenCalledWith('profile-b');
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'home-b-token' }),
      serverId: 'profile-b',
      serverApiUrl: 'https://b.example',
    }));
    expect(resolveSessionTarget).toHaveBeenCalledWith('same-session-id');
    expect(execute).toHaveBeenCalledWith(
      'action.options.resolve',
      expect.objectContaining({ sessionId: 'session_on_b' }),
      expect.objectContaining({ defaultSessionId: 'session_on_b' }),
    );
  });

  it('fails softly on an invalid exact-Home selector before reading any credentials', async () => {
    const readCredentialsFn = vi.fn();
    const readCredentialsForServerIdFn = vi.fn();
    const createExecutorFn = vi.fn();

    await expect(resolveActionDynamicOptionsForCliCompletion({
      actionId: 'execution.run.start',
      fieldPath: 'agent',
      optionsSourceId: 'execution.backends.enabled',
      draftInput: { sessionId: 'session_1' },
      query: '',
      committedArgv: [
        'session_1',
        '--server-id', 'profile-a',
        '--server-id', 'profile-b',
        '--agent',
      ],
      acceptsServerId: true,
    }, {
      readCredentialsFn,
      readCredentialsForServerIdFn,
      getServerProfileFn: vi.fn(),
      createExecutorFn,
    })).resolves.toEqual([]);

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(readCredentialsForServerIdFn).not.toHaveBeenCalled();
    expect(createExecutorFn).not.toHaveBeenCalled();
  });

  it('fails softly without credentials or an exact Session', async () => {
    const execute = vi.fn();
    await expect(resolveActionDynamicOptionsForCliCompletion({
      actionId: 'execution.run.start',
      fieldPath: 'agent',
      optionsSourceId: 'execution.backends.enabled',
      draftInput: {},
      query: '',
      committedArgv: [],
      acceptsServerId: false,
    }, {
      readCredentialsFn: async () => null,
      createExecutorFn: () => ({ execute, resolveSessionTarget: vi.fn() }),
    })).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();

    await expect(resolveActionDynamicOptionsForCliCompletion({
      actionId: 'execution.run.start',
      fieldPath: 'agent',
      optionsSourceId: 'execution.backends.enabled',
      draftInput: { sessionId: 'ambiguous' },
      query: '',
      committedArgv: [],
      acceptsServerId: false,
    }, {
      readCredentialsFn: async () => ({ token: 'hap_v1.test', encryption: null, credentialProvenance: 'stored_session' }),
      createExecutorFn: () => ({
        execute,
        resolveSessionTarget: vi.fn(async () => ({ ok: false as const, code: 'ambiguous_session', candidates: ['a', 'b'] })),
      }),
    })).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
