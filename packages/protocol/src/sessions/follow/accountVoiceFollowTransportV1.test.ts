import { describe, expect, it } from 'vitest';

import {
  AccountVoiceFollowAcknowledgeRequestV1Schema,
  AccountVoiceFollowAcknowledgeResponseV1Schema,
  AccountVoiceFollowObservePendingRequestV1Schema,
  AccountVoiceFollowObservePendingResponseV1Schema,
} from './accountVoiceFollowTransportV1.js';

const frontier = {
  transcriptSeq: 1,
  readyEventSeq: 2,
  agentStateVersion: 3,
  turn: { id: 'turn-1', status: 'completed' as const },
};

describe('Account Voice Follow transport V1', () => {
  it('admits a strict initial pending snapshot with a nullable expected frontier', () => {
    const value = {
      ok: true as const,
      v: 1 as const,
      voiceSessionId: 'voice-session',
      publisherGeneration: '4',
      executionRunOccurrenceId: 'voice-occurrence-1',
      observations: [{
        sourceSessionId: 'source-session',
        voiceSessionId: 'voice-session',
        expected: null,
        observed: frontier,
        policy: { preset: 'custom' as const, events: { finished: { delivery: 'quiet' as const, voice: true } } },
      }],
    };

    expect(AccountVoiceFollowObservePendingResponseV1Schema.parse(value)).toEqual(value);
    expect(AccountVoiceFollowObservePendingResponseV1Schema.safeParse({ ...value, pendingUserMessage: true }).success)
      .toBe(false);
    expect(AccountVoiceFollowObservePendingRequestV1Schema.parse({
      v: 1,
      voiceSessionId: 'voice-session',
      executionRunId: 'voice-run-1',
    })).toEqual({ v: 1, voiceSessionId: 'voice-session', executionRunId: 'voice-run-1' });
    expect(AccountVoiceFollowObservePendingRequestV1Schema.safeParse({
      v: 1,
      voiceSessionId: 'voice-session',
    }).success).toBe(false);
  });

  it('requires distinct Sessions and a strict provider-acceptance identity', () => {
    const value = {
      v: 1 as const,
      voiceSessionId: 'voice-session',
      executionRunId: 'voice-run-1',
      expectedExecutionRunOccurrenceId: 'voice-occurrence-1',
      sourceSessionId: 'source-session',
      expectedPublisherGeneration: '4',
      expected: null,
      observed: frontier,
      consumed: frontier,
      acceptance: { localInputId: 'input-1', userMessageSeq: null },
      policy: { preset: 'important' as const, voice: true },
    };

    expect(AccountVoiceFollowAcknowledgeRequestV1Schema.parse(value)).toEqual(value);
    expect(AccountVoiceFollowAcknowledgeRequestV1Schema.safeParse({ ...value, sourceSessionId: 'voice-session' }).success)
      .toBe(false);
    expect(AccountVoiceFollowAcknowledgeRequestV1Schema.safeParse({ ...value, acceptance: { localInputId: '' } }).success)
      .toBe(false);
    const { observed: _observed, ...withoutObserved } = value;
    expect(AccountVoiceFollowAcknowledgeRequestV1Schema.safeParse(withoutObserved).success).toBe(false);
    expect(AccountVoiceFollowAcknowledgeResponseV1Schema.parse({
      ok: false,
      v: 1,
      error: 'provider_acceptance_unverified',
    })).toEqual({ ok: false, v: 1, error: 'provider_acceptance_unverified' });
  });
});
