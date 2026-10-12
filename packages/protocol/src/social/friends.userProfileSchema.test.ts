import { describe, expect, it } from 'vitest';

import {
  UserProfileSchema,
  UserRecipientEnvelopeResponseSchema,
  UsersSearchQueryV1Schema,
  UsersSearchResponseSchema,
} from './friends.js';

describe('UserProfileSchema', () => {
  it('normalizes released names only when name is absent, preserving an explicit clear', () => {
    const legacy = { id: 'u_legacy', firstName: ' Legacy ', lastName: ' Person ', avatar: null,
      username: 'legacy', bio: null, status: 'friend', publicKey: null };
    expect(UserProfileSchema.parse(legacy).name).toBe('Legacy Person');
    expect(UserProfileSchema.parse({ ...legacy, name: ' Chosen Name ' }).name).toBe('Chosen Name');
    expect(UserProfileSchema.parse({ ...legacy, name: null }).name).toBeNull();
  });
  it('accepts keyless accounts (publicKey=null)', () => {
    const parsed = UserProfileSchema.parse({
      id: 'u_1',
      firstName: 'A',
      lastName: null,
      avatar: null,
      username: 'alice',
      bio: null,
      badges: [],
      status: 'none',
      publicKey: null,
      contentPublicKey: null,
      contentPublicKeySig: null,
    });

    expect(parsed.publicKey).toBeNull();
  });

  it('preserves the server-owned recipient-envelope readiness projection when present', () => {
    const parsed = UserRecipientEnvelopeResponseSchema.parse({
      user: {
        id: 'u_2',
        firstName: 'B',
        lastName: null,
        avatar: null,
        username: 'bob',
        bio: null,
        badges: [],
        status: 'friend',
        publicKey: '00'.repeat(32),
        contentPublicKey: null,
        contentPublicKeySig: null,
        recipientEnvelopeReadiness: {
          status: 'unavailable',
          reason: 'plain_account',
        },
      },
    });

    expect(parsed.user.recipientEnvelopeReadiness).toEqual({
      status: 'unavailable',
      reason: 'plain_account',
    });

    const withoutReadiness = { ...parsed, user: { ...parsed.user } };
    delete (withoutReadiness.user as { recipientEnvelopeReadiness?: unknown }).recipientEnvelopeReadiness;
    expect(UserRecipientEnvelopeResponseSchema.safeParse(withoutReadiness).success).toBe(false);
  });
});

describe('user search pagination', () => {
  it('accepts an opaque continuation while remaining compatible with released bounded responses', () => {
    expect(UsersSearchQueryV1Schema.parse({ query: '', cursor: 'next-page' }))
      .toEqual({ query: '', cursor: 'next-page' });
    expect(UsersSearchResponseSchema.parse({ users: [] })).toEqual({ users: [] });
    expect(UsersSearchResponseSchema.parse({ users: [], nextCursor: null }))
      .toEqual({ users: [], nextCursor: null });
  });

  it('accepts the collaboration discovery purpose without widening arbitrary query fields', () => {
    expect(UsersSearchQueryV1Schema.parse({ query: 'ali', purpose: 'collaboration' }))
      .toEqual({ query: 'ali', purpose: 'collaboration' });
    expect(() => UsersSearchQueryV1Schema.parse({ query: 'ali', purpose: 'administration' }))
      .toThrow();
  });
});
