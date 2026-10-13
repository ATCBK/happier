import { describe, expect, it } from 'vitest';
import { createSessionOwnerMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import {
  readVoiceProviderConversationMetadata,
  writeVoiceProviderConversationMetadata,
} from './voiceProviderConversationMetadata';

describe('voice provider conversation metadata', () => {
  it('round-trips a canonical qualified external provider identity', () => {
    const providerId = 'acme.synthetic-voice/conversation';
    const metadata = writeVoiceProviderConversationMetadata(
      { retained: true },
      { providerId, state: { conversationId: 'external-conversation-1' }, updatedAt: 15 },
    );

    expect(metadata).toMatchObject({
      retained: true,
      voiceProviderConversationsV1: {
        v: 1,
        providers: {
          [providerId]: {
            conversationId: 'external-conversation-1',
            updatedAt: 15,
          },
        },
      },
    });
    expect(readVoiceProviderConversationMetadata(metadata, providerId)).toEqual({
      conversationId: 'external-conversation-1',
      updatedAt: 15,
    });
    // Serialize the real writer's output into the exact Session owner schema.
    const owner = createSessionOwnerMetadataV1({ metadata: JSON.parse(JSON.stringify(
      writeVoiceProviderConversationMetadata({}, { providerId,
        state: { conversationId: 'external-conversation-1' }, updatedAt: 15 }),
    )) });
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error(`Invalid provider metadata: ${owner.unsupportedFields.join(',')}`);
    expect(SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata).system?.voiceProviderConversationsV1)
      .toEqual(Reflect.get(metadata, 'voiceProviderConversationsV1'));
  });

  it('keeps the original timestamp when the same provider conversation is published again', () => {
    const providerId = 'happier.voice.xai/realtime-grok';
    const first = writeVoiceProviderConversationMetadata(
      {},
      { providerId, state: { conversationId: 'conversation-1' }, updatedAt: 10 },
    );

    const second = writeVoiceProviderConversationMetadata(
      first,
      { providerId, state: { conversationId: 'conversation-1' }, updatedAt: 20 },
    );

    expect(readVoiceProviderConversationMetadata(second, providerId)?.updatedAt).toBe(10);
  });

  it('round-trips provider-owned resumable identity without overwriting siblings', () => {
    const first = writeVoiceProviderConversationMetadata(
      { retained: true },
      { providerId: 'happier.voice.xai/realtime-grok', state: { conversationId: 'conversation-1' }, updatedAt: 10 },
    );
    const second = writeVoiceProviderConversationMetadata(
      first,
      { providerId: 'happier.voice.openai/realtime-openai', state: { conversationId: 'conversation-2' }, updatedAt: 20 },
    );

    expect(readVoiceProviderConversationMetadata(second, 'happier.voice.xai/realtime-grok')).toEqual({
      conversationId: 'conversation-1',
      updatedAt: 10,
    });
    expect(second).toMatchObject({ retained: true });
  });

  it('clears only the requested provider and removes an empty envelope', () => {
    const metadata = writeVoiceProviderConversationMetadata(
      writeVoiceProviderConversationMetadata({ retained: true }, {
        providerId: 'happier.voice.xai/realtime-grok', state: { conversationId: 'conversation-1' }, updatedAt: 10,
      }), {
        providerId: 'happier.voice.openai/realtime-openai', state: { conversationId: 'conversation-2' }, updatedAt: 20,
      });

    const oneLeft = writeVoiceProviderConversationMetadata(metadata, {
      providerId: 'happier.voice.xai/realtime-grok', state: null, updatedAt: 30,
    });
    expect(readVoiceProviderConversationMetadata(oneLeft, 'happier.voice.xai/realtime-grok')).toBeNull();
    expect(readVoiceProviderConversationMetadata(oneLeft, 'happier.voice.openai/realtime-openai')?.conversationId).toBe('conversation-2');

    const empty = writeVoiceProviderConversationMetadata(oneLeft, {
      providerId: 'happier.voice.openai/realtime-openai', state: null, updatedAt: 40,
    });
    expect(empty).toEqual({ retained: true });
  });

  it('fails closed for unsafe provider keys and malformed persisted identities', () => {
    const oversizedProviderId = `acme.synthetic-voice/${'a'.repeat(256)}`;

    expect(() => writeVoiceProviderConversationMetadata({}, {
      providerId: '__proto__', state: { conversationId: 'conversation-1' }, updatedAt: 10,
    })).toThrow('invalid_voice_provider_id');
    expect(() => writeVoiceProviderConversationMetadata({}, {
      providerId: 'acme.synthetic-voice/', state: { conversationId: 'conversation-1' }, updatedAt: 10,
    })).toThrow('invalid_voice_provider_id');
    expect(() => writeVoiceProviderConversationMetadata({}, {
      providerId: oversizedProviderId, state: { conversationId: 'conversation-1' }, updatedAt: 10,
    })).toThrow('invalid_voice_provider_id');
    expect(readVoiceProviderConversationMetadata({
      voiceProviderConversationsV1: {
        v: 1,
        providers: {
          'happier.voice.xai/realtime-grok': { conversationId: '', updatedAt: 10 },
          'acme.synthetic-voice/': { conversationId: 'malformed', updatedAt: 10 },
          [oversizedProviderId]: { conversationId: 'oversized', updatedAt: 10 },
        },
      },
    }, 'happier.voice.xai/realtime-grok')).toBeNull();
    expect(readVoiceProviderConversationMetadata({
      voiceProviderConversationsV1: {
        v: 1,
        providers: {
          'acme.synthetic-voice/': { conversationId: 'malformed', updatedAt: 10 },
          [oversizedProviderId]: { conversationId: 'oversized', updatedAt: 10 },
        },
      },
    }, 'acme.synthetic-voice/')).toBeNull();
    expect(readVoiceProviderConversationMetadata({
      voiceProviderConversationsV1: {
        v: 1,
        providers: {
          [oversizedProviderId]: { conversationId: 'oversized', updatedAt: 10 },
        },
      },
    }, oversizedProviderId)).toBeNull();
  });
});
