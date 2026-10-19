import type { VoiceClientToolDefinition } from '@happier-dev/plugin-sdk/voice/client';
import { describe, expect, it, vi } from 'vitest';

import {
  ElevenLabsProvisionRequestSchema,
  type ElevenLabsProvisionRequest,
} from '../../protocol/voice/index.js';
import { createElevenLabsAutoprovision } from './autoprovision.js';

describe('ElevenLabs bundled autoprovision', () => {
  it('provisions the host-normalized Voice client tools without rebuilding ActionSpec schemas', async () => {
    const provision = vi.fn(async (request: ElevenLabsProvisionRequest, _signal: AbortSignal) => {
      const parsed = ElevenLabsProvisionRequestSchema.parse(request);
      return parsed.kind === 'update'
        ? { ok: true, updated: true }
        : { ok: true, agentId: 'agent_1' };
    });
    const tools: readonly VoiceClientToolDefinition[] = Object.freeze([Object.freeze({
      name: 'hostListMachines',
      description: 'Host-normalized machine inventory',
      parameters: Object.freeze({
        type: 'object',
        additionalProperties: false,
        properties: Object.freeze({
          limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 10 }),
        }),
        required: Object.freeze(['limit']),
      }),
      execute: async () => Object.freeze({ ok: true }),
    })]);
    const autoprovision = createElevenLabsAutoprovision({
      client: { provision },
      defaultVoiceId: 'voice_default',
      tools,
    });
    const signal = new AbortController().signal;

    await expect(autoprovision.createAgent(
      {
        tts: {
          voiceId: 'voice_1',
          voiceSettings: {
            stability: 0.35,
            similarityBoost: 0.75,
            speed: 1.1,
          },
        },
      },
      signal,
    )).resolves.toEqual({ agentId: 'agent_1' });
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'create',
      prompt: expect.stringContaining('{{initialConversationContext}}'),
      tools: [
        {
          name: 'hostListMachines',
          description: 'Host-normalized machine inventory',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } },
            required: ['limit'],
          },
        },
      ],
      tts: expect.objectContaining({ voiceId: 'voice_1' }),
    }), signal);
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      tts: expect.objectContaining({
        voiceSettings: expect.objectContaining({
          stability: 0.35,
          similarityBoost: 0.75,
          speed: 1.1,
        }),
      }),
    }), signal);
    const provisionedRequest = provision.mock.calls[0]?.[0];
    if (!provisionedRequest || provisionedRequest.kind !== 'create') {
      throw new Error('Expected a create provisioning request');
    }
    const provisionedPrompt = provisionedRequest.prompt;
    // ElevenLabs substitutes these dynamic variables at conversation start; the
    // plugin owns that dialect, so losing either one silently ships a prompt with
    // no session target and no conversation context.
    expect(provisionedPrompt).toContain('Active coding session (internal tool target): {{sessionId}}');
    expect(provisionedPrompt).toContain('Conversation context (may be empty):\n{{initialConversationContext}}');

    const serialized = JSON.stringify(provision.mock.calls);
    expect(serialized).toContain('hostListMachines');
    expect(serialized).not.toContain('sendSessionMessage');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toMatch(/(?:style|useSpeakerBoost|use_speaker_boost|voice_settings)/u);

    await expect(autoprovision.updateAgent({ agentId: 'agent_1' }, signal)).resolves.toBeUndefined();
    expect(provision.mock.calls[1]?.[0]).toMatchObject({
      kind: 'update', agentId: 'agent_1',
      tools: provisionedRequest.tools,
      tts: { voiceId: 'voice_default' },
    });
  });

  it('rejects a malformed host tool before forwarding create or update to the Account operation', async () => {
    const provision = vi.fn(async (_request: ElevenLabsProvisionRequest, _signal: AbortSignal) => ({
      ok: true, agentId: 'agent_1', updated: true,
    }));
    const autoprovision = createElevenLabsAutoprovision({
      client: { provision }, defaultVoiceId: 'voice_default',
      tools: [{
        name: '', description: 'Invalid unnamed tool', parameters: { type: 'object' },
        execute: async () => ({ ok: true }),
      }],
    });
    const signal = new AbortController().signal;
    await expect(autoprovision.createAgent({}, signal)).rejects.toThrow();
    await expect(autoprovision.updateAgent({ agentId: 'agent_1' }, signal)).rejects.toThrow();
    expect(provision).not.toHaveBeenCalled();
  });
});
