import { expect, it } from 'vitest';
import { ConversationTurnOriginV1Schema, readConversationTurnOriginV1FromMessageMeta } from './conversationTurnOriginV1.js';

it('retains stored conversation channel/source provenance through retired fields without admitting mixed modalities', () => {
  const origin = { v: 1, channel: 'agent_thread', modality: 'text',
    source: { pluginId: 'happier.agent.codex', contributionId: 'conversation' } };
  const annotated = { ...origin, retired: true, source: { ...origin.source, retired: true } };
  expect(readConversationTurnOriginV1FromMessageMeta({ happier: { conversationTurnOriginV1: annotated } }))
    .toEqual(origin);
  expect(readConversationTurnOriginV1FromMessageMeta({ happier: { conversationTurnOriginV1: {
    ...annotated, modality: 'voice',
  } } })).toBeNull();
  expect(ConversationTurnOriginV1Schema.safeParse(annotated).success).toBe(false);
  expect(readConversationTurnOriginV1FromMessageMeta({ happier: { conversationTurnOriginV1: annotated } }, 'input'))
    .toBeNull();
  expect(readConversationTurnOriginV1FromMessageMeta({ happier: { conversationTurnOriginV1: origin } }, 'input'))
    .toEqual(origin);
});
