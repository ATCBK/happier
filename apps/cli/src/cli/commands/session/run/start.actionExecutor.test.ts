import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionRunIntentSchema } from '@happier-dev/protocol/execution/runs/runPrimitives';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutor = vi.fn(() => ({ execute }));
const resolveSessionTarget = vi.fn(async () => ({ ok: true as const, sessionId: 'sess-1' }));
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute, resolveSessionTarget }));

vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));
vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

const resolveSessionTransportContext = vi.fn(async () => ({
  ok: true,
  sessionId: 'sess-1',
  rawSession: { id: 'sess-1', active: true, metadata: {} },
  ctx: null,
  mode: 'plain' as const,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

const ensureCliActionPolicySettings = vi.fn(async () => {});
vi.mock('@/session/actions/ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(() => ({
    agentDefinitionsById: new Map([
      [
        'com.acme.review/review-bot',
        {
          id: 'com.acme.review/review-bot',
          identity: { pluginId: 'com.acme.review', localId: 'review-bot' },
        },
      ],
    ]),
  })),
}));
vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

describe('happier session run start (action executor)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionTarget.mockResolvedValue({ ok: true, sessionId: 'sess-1' });
  });

  it('routes through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1' },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        [
          'run',
          'start',
          'sess-1',
          '--intent',
          'review',
          '--agent',
          'agent:claude',
          '--permission-mode',
          'read_only',
          '--retention',
          'ephemeral',
          '--run-class',
          'bounded',
          '--io-mode',
          'request_response',
          '--json',
        ],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(createCliActionExecutorFromCredentials).toHaveBeenCalledTimes(1);
      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(createCliActionExecutor).not.toHaveBeenCalled();
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        'execution.run.start',
        {
          sessionId: 'sess-1',
          intent: 'review',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
      );

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_run_start',
        data: expect.objectContaining({
          sessionId: 'sess-1',
          runId: 'run-1',
        }),
      }));
    } finally {
      output.restore();
    }
  });

  it('resolves a qualified external Agent run start target through the catalog', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, runId: 'run-ext-1', callId: 'call-ext-1', sidechainId: 'sidechain-ext-1' },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'start', 'sess-1', '--intent', 'review', '--agent', 'agent:com.acme.review/review-bot', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );

      expect(execute).toHaveBeenCalledWith(
        'execution.run.start',
        expect.objectContaining({
          sessionId: 'sess-1',
          intent: 'review',
          backendTarget: { kind: 'backend', backendId: 'com.acme.review/review-bot', sourceKind: 'built_in' },
        }),
        expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
      );
      expect(output.json()).toEqual(expect.objectContaining({ ok: true, kind: 'session_run_start' }));
    } finally {
      output.restore();
    }
  });

  it('selects the public Action transport before legacy Session bootstrap for API tokens', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1' },
    });

    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'start', 'sess-1', '--intent', 'review', '--agent', 'agent:claude', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'hap_v1_token_secret',
            encryption: null,
            credentialProvenance: 'api_token' as const,
          }),
        },
      );

      expect(resolveSessionTarget).toHaveBeenCalledWith('sess-1');
      expect(createCliActionExecutor).not.toHaveBeenCalled();
      expect(resolveSessionTransportContext).not.toHaveBeenCalled();
      expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
      expect(output.json()).toEqual(expect.objectContaining({ ok: true, kind: 'session_run_start' }));
    } finally {
      output.restore();
    }
  });

  const startWith = async (extraArgv: readonly string[]): Promise<void> => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1' },
    });
    const { handleSessionCommand } = await import('../handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['run', 'start', 'sess-1', '--agent', 'agent:claude', ...extraArgv, '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );
    } finally {
      output.restore();
    }
  };

  it.each(ExecutionRunIntentSchema.options)(
    'admits the friendly %s start as a request the canonical start schema accepts',
    async (intent) => {
      // scm_diff_summary has required typed input (its comparison source), which the
      // friendly command takes through the canonical whole-input JSON.
      const typedInput = intent === 'scm_diff_summary'
        ? ['--input-json', JSON.stringify({ intentInput: { cwd: '/repo', source: { kind: 'workingTree' } } })]
        : [];
      await startWith(['--intent', intent, '--instructions', 'Do the work.', ...typedInput]);

      expect(execute).toHaveBeenCalledTimes(1);
      const [actionId, input] = execute.mock.calls[0] as unknown as [string, unknown];
      expect(actionId).toBe('execution.run.start');
      const admitted = ExecutionRunStartRequestSchema.safeParse(input);
      expect(admitted.error?.issues ?? []).toEqual([]);
    },
  );

  it('starts a commit-message Run with its typed kind and caller-supplied intent input', async () => {
    await startWith([
      '--intent',
      'scm_commit_message',
      '--input-json',
      JSON.stringify({ intentInput: { instructions: 'Keep it short.', scope: { kind: 'paths', include: ['src/a.ts'] } } }),
    ]);

    expect(execute).toHaveBeenCalledWith(
      'execution.run.start',
      expect.objectContaining({
        sessionId: 'sess-1',
        kind: 'scm_commit_message.v1',
        intent: 'scm_commit_message',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        intentInput: { instructions: 'Keep it short.', scope: { kind: 'paths', include: ['src/a.ts'] } },
      }),
      expect.objectContaining({ surface: 'cli' }),
    );
  });
});
