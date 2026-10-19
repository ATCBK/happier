import { describe, expect, it } from 'vitest';
import { deriveSessionInputActionRequestAttributionV1, materializeActionRequestAttributionV1 } from './actionRequestAttributionV1.js';
import { SessionMessageRefV1Schema } from '../sessions/messages/sessionMessageRefV1.js';
import { CoordinationMessageRefV1Schema } from '../discussions/messageRefs.js';
import { settleSessionInputRequestV1 } from '../sessions/messages/sessionInputAdmission.js';

describe('host request attribution custody', () => {
  const persona = { serverId: 'home', sessionId: 'bot' };

  it('derives the requester from the receipt while retaining the distinct committed origin', () => {
    const origin = CoordinationMessageRefV1Schema.parse(SessionMessageRefV1Schema.parse({
      kind: 'session', session: persona, messageId: 'committed-message',
    }));
    expect(deriveSessionInputActionRequestAttributionV1({ requestRef: 'original-input', persona, origin,
      messageRole: 'user', inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount',
        actorAccountId: 'bob', sessionRelationship: 'sharedEditor' },
    })).toEqual({ requestRef: 'original-input', requester: { serverId: 'home', accountId: 'bob' }, persona, origin });
    expect(deriveSessionInputActionRequestAttributionV1({ requestRef: 'original-input', persona, origin,
      messageRole: 'user', inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
    })?.requester).toBeNull();
    expect(deriveSessionInputActionRequestAttributionV1({ requestRef: 'original-input', persona, origin,
      messageRole: 'user', inputAdmissionReceipt: undefined,
    })).toBeUndefined();
  });

  it('keeps an earlier request immutable when a later caller mutates source objects', () => {
    const input = { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' }, persona: { ...persona },
      origin: { kind: 'discussion' as const, discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'committed-post' } };
    const retained = materializeActionRequestAttributionV1(input);
    input.requester.accountId = 'carol';
    input.origin.messageId = 'later-post';
    expect(retained).toMatchObject({ requester: { accountId: 'bob' }, origin: { messageId: 'committed-post' } });
    expect(Object.isFrozen(retained.requester)).toBe(true);
    expect(Object.isFrozen(retained.origin)).toBe(true);
  });

  it('retains the admitted original cause on a forwarded machine input, never an Account-authored claim', () => {
    const cause = { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' }, persona,
      origin: { kind: 'session' as const, session: persona, messageId: 'bob-message' } };
    const authority = { v: 1 as const, producer: 'sessionAction' as const, caller: { kind: 'host' as const },
      sourceSession: { sourceSessionId: 'sender', sourceTurnId: 'sender-turn', via: 'action' as const },
      permission: { admittedPermissionCeiling: 'default' as const }, actionRequestAttributionV1: cause };
    const derive = (inputAdmissionReceipt: unknown) => deriveSessionInputActionRequestAttributionV1({
      requestRef: 'forwarded-input', persona: { serverId: 'home', sessionId: 'receiver' }, origin: null,
      messageRole: 'user', inputAdmissionReceipt, inputAuthority: authority,
    });
    expect(derive({ v: 1, issuer: 'authenticatedMachine' })).toEqual(cause);
    expect(derive({ v: 1, issuer: 'authenticatedAccount', actorAccountId: 'carol', sessionRelationship: 'owner' }))
      .toMatchObject({ requestRef: 'forwarded-input', requester: { accountId: 'carol' } });
    const { admittedPermissionCeiling: _, ...permission } = authority.permission;
    expect(() => settleSessionInputRequestV1({ request: { ...authority, permission },
      currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: {
        v: 1, issuer: 'authenticatedAccount', actorAccountId: 'bot-owner', sessionRelationship: 'owner',
      } })).toThrow();
    expect(derive({ v: 1, issuer: 'authenticatedMachine' })?.requester?.accountId).toBe('bob');
  });
});
