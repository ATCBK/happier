import { describe, expect, it } from 'vitest';

import {
  AccountDisplayProfileV1Schema,
  parseAccountDisplayProfileV1,
} from './accountDisplayProfileV1.js';

describe('AccountDisplayProfileV1', () => {
  it('accepts the four neutral presentation fields', () => {
    expect(AccountDisplayProfileV1Schema.parse({
      firstName: 'Alice',
      lastName: 'Chen',
      username: 'alice',
      avatarUrl: 'https://example.test/a.png',
    })).toEqual({
      name: 'Alice Chen',
      firstName: 'Alice',
      lastName: 'Chen',
      username: 'alice',
      avatarUrl: 'https://example.test/a.png',
    });
  });

  it('accepts an Account with no resolvable display fields', () => {
    expect(AccountDisplayProfileV1Schema.parse({
      firstName: null,
      lastName: null,
      username: null,
      avatarUrl: null,
    })).toEqual({
      name: null,
      firstName: null,
      lastName: null,
      username: null,
      avatarUrl: null,
    });
  });

  it('requires every field so a partial projection cannot silently disclose less', () => {
    expect(AccountDisplayProfileV1Schema.safeParse({ firstName: 'Alice' }).success).toBe(false);
  });

  it('rejects identity, relationship, key, and role fields', () => {
    for (const forbidden of [
      { id: 'acc_1' },
      { email: 'a@example.test' },
      { homeRole: 'admin' },
      { relationship: 'friend' },
      { publicKey: 'k' },
      { contentPublicKey: 'k' },
      { bio: 'hello' },
      { accessLevel: 'editor' },
      { teamId: 'team_1' },
    ]) {
      expect(AccountDisplayProfileV1Schema.safeParse({
        firstName: null,
        lastName: null,
        username: null,
        avatarUrl: null,
        ...forbidden,
      }).success).toBe(false);
    }
  });

  it('parses defensively without throwing on unknown input', () => {
    expect(parseAccountDisplayProfileV1(undefined)).toBeNull();
    expect(parseAccountDisplayProfileV1({ firstName: 1 })).toBeNull();
    expect(parseAccountDisplayProfileV1({
      firstName: null,
      lastName: null,
      username: 'alice',
      avatarUrl: null,
    })).toEqual({ name: null, firstName: null, lastName: null, username: 'alice', avatarUrl: null });
  });
});
