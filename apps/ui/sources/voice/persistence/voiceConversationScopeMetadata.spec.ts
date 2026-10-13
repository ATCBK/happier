import { describe, expect, it } from 'vitest';
import { createSessionOwnerMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { writeVoiceConversationScopeMetadata } from './voiceConversationScopeMetadata';

describe('writeVoiceConversationScopeMetadata', () => {
  it('trims session root ids when writing metadata', () => {
    expect(
      writeVoiceConversationScopeMetadata(
        { existing: true },
        { kind: 'session_root', sessionRootId: '  root-session  ' },
      ),
    ).toEqual({
      existing: true,
      voiceConversationScopeV1: {
        v: 1,
        kind: 'session_root',
        sessionRootId: 'root-session',
      },
    });
    const metadata = writeVoiceConversationScopeMetadata({}, { kind: 'session_root', sessionRootId: '  root-session  ' });
    const owner = createSessionOwnerMetadataV1({ metadata: JSON.parse(JSON.stringify(metadata)) });
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error(`Invalid conversation scope: ${owner.unsupportedFields.join(',')}`);
    expect(SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata).system?.voiceConversationScopeV1)
      .toEqual(metadata.voiceConversationScopeV1);
  });

  it('rejects session root ids that normalize to empty strings', () => {
    expect(() =>
      writeVoiceConversationScopeMetadata(
        { existing: true },
        { kind: 'session_root', sessionRootId: '   ' },
      ),
    ).toThrow(TypeError);
  });
});
