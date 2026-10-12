import { describe, expect, it } from 'vitest';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { readSessionMessageModelSelectionV1 } from '../../providers/selection/v1.js';
import { SessionMessageMetaSchema } from './sessionMessageMeta.js';

describe('stored message model intent', () => {
  it('preserves admitted and malformed provider-bound intent for the canonical reader', () => {
    const selection = { v: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: null, modelId: 'restricted-model' }, updatedAt: 1000 };
    const reader = createStoredReadSchema(SessionMessageMetaSchema);
    const parsed = reader.parse({ model: 'restricted-model', modelSelectionV1: selection, futureDomainField: true });
    expect(parsed).toEqual({ model: 'restricted-model', modelSelectionV1: selection });
    expect(readSessionMessageModelSelectionV1(parsed)).toEqual({ status: 'valid', selection });
    const malformed = reader.parse({ model: 'legacy-fallback-must-not-run', modelSelectionV1: { v: 2 } });
    expect(malformed.modelSelectionV1).toEqual({ v: 2 });
    expect(readSessionMessageModelSelectionV1(malformed)).toEqual({ status: 'invalid' });
  });
});
