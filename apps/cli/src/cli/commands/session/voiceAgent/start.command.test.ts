import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import {
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
  type ExternalActionRequestEnvelopeV1,
} from '@happier-dev/protocol/actions/externalActionApi';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { cmdSessionVoiceAgentStart } from './start';

describe('happier session voice-agent start command', () => {
  const sessionId = 'c123456789012345678901234';
  const token = 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43);
  const requests: { actionId: string; envelope: ExternalActionRequestEnvelopeV1 }[] = [];
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let app: FastifyInstance;
  let homeDir = '';

  beforeEach(async () => {
    requests.length = 0;
    homeDir = await createTempDir('happier-voice-command-');
    app = Fastify();
    // Only the Home HTTP service is substituted. The command, selector,
    // credentialed executor, option resolution and SDK schemas stay real.
    app.post<{ Params: { actionId: string }; Body: unknown }>('/v1/actions/:actionId', async (request) => {
      const actionId = request.params.actionId;
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.body);
      expect(request.headers.authorization).toBe('Bearer ' + token);
      requests.push({ actionId, envelope });
      const result = actionId === 'session.list'
        ? { sessions: [{ id: sessionId, tag: 'sess-voice', createdAt: 1, updatedAt: 2,
            active: true, activeAt: 2, share: null, encryption: null }], nextCursor: null, hasNext: false }
        : actionId === 'action.options.resolve'
          ? { actionId: 'voice_agent.start', fieldPath: 'backendTargetKeys',
              optionsSourceId: 'execution.backends.enabled',
              options: [{ value: 'agent:com.acme.agent/acme', label: 'Acme Agent' }] }
          : actionId === 'voice_agent.start'
            ? { results: [{ key: 'agent:com.acme.agent/acme' }] }
            : (() => { throw new Error('Unexpected Action: ' + actionId); })();
      const outputSchema = getActionSpec(ActionIdSchema.parse(actionId)).outputSchema;
      if (!outputSchema) throw new Error('Expected a declared Action output schema');
      const parsedResult = outputSchema.parse(result);
      return ExternalActionResponseEnvelopeV1Schema.parse({
        v: 1, actionId,
        ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
        execution: { ok: true, result: parsedResult },
      });
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    envScope = createEnvKeyScope(envKeys);
    envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: origin, HAPPIER_WEBAPP_URL: origin });
    reloadConfiguration();
  });

  afterEach(async () => {
    await app.close();
    if (homeDir) await removeTempDir(homeDir);
    envScope.restore();
    reloadConfiguration();
  });

  it('resolves the requested backend through the voice action options source', async () => {
    const output = captureConsoleJsonOutput();
    try {
      await cmdSessionVoiceAgentStart([
        'voice-agent', 'start', 'sess-voice', '--backends', 'Acme Agent',
        '--instructions', 'Voice.', '--machine-id', 'machine-voice', '--json',
      ], { readCredentialsFn: async () => ({ token, encryption: null, credentialProvenance: 'api_token' }) });

      expect(output.json()).toEqual({
        v: 1, ok: true, kind: 'session_voice_agent_start',
        data: { sessionId, results: [{ key: 'agent:com.acme.agent/acme' }] },
      });
      expect(requests.filter(({ actionId }) => actionId === 'action.options.resolve').map(({ envelope }) => envelope)).toEqual([{
        v: 1, target: { kind: 'machine', machineId: 'machine-voice' },
        input: { actionId: 'voice_agent.start', fieldPath: 'backendTargetKeys',
          optionsSourceId: 'execution.backends.enabled', sessionId, includeDisabled: true },
      }]);
      expect(requests.filter(({ actionId }) => actionId === 'voice_agent.start').map(({ envelope }) => envelope)).toEqual([{
        v: 1, requestId: expect.any(String), target: { kind: 'machine', machineId: 'machine-voice' },
        input: { sessionId, backendTargetKeys: ['agent:com.acme.agent/acme'], instructions: 'Voice.',
          permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'long_lived', ioMode: 'streaming' },
      }]);
    } finally {
      output.restore();
    }
  });

  it.each([
    ['unknown option', ['voice-agent', 'start', 'sess', '--backends', 'codex', '--instructions', 'Voice.', '--bogus']],
    ['missing machine value', ['voice-agent', 'start', 'sess', '--backends', 'codex', '--instructions', 'Voice.', '--machine-id', '--json']],
  ])('rejects %s before credential or Action work', async (_name, argv) => {
    const readCredentialsFn = vi.fn();
    await expect(cmdSessionVoiceAgentStart(argv, { readCredentialsFn })).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
