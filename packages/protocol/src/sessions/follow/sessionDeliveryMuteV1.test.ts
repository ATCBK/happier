import { describe, expect, it } from 'vitest';

import {
  FollowDeliveryMuteScopeV1Schema,
  isFollowDeliveryMutedV1,
} from './sessionDeliveryMuteV1.js';
import { resolveSessionFollowActionRequest } from './actionTransport.js';
import { getActionSpec } from '../../actions/actionSpecs.js';
import { resolveActionApprovalRouting } from '../../actions/actionApprovalPolicy.js';

describe('receiver delivery mute', () => {
  it('suppresses an exact sender across routes and an exact source without muting a different sender', () => {
    const scopes = [
      { kind: 'sender_session' as const, sessionId: 'sender-a' },
      { kind: 'source' as const, source: { kind: 'discussion' as const, discussionId: 'discussion-a' } },
    ];
    expect(isFollowDeliveryMutedV1(scopes, {
      senderSessionId: 'sender-a', source: { kind: 'session', sessionId: 'source-a' },
    })).toBe(true);
    expect(isFollowDeliveryMutedV1(scopes, {
      senderSessionId: 'sender-b', source: { kind: 'discussion', discussionId: 'discussion-a' },
    })).toBe(true);
    expect(isFollowDeliveryMutedV1(scopes, {
      senderSessionId: 'sender-b', source: { kind: 'session', sessionId: 'source-a' },
    })).toBe(false);
  });

  it('rejects selectors and extra routing authority in an exact scope', () => {
    expect(FollowDeliveryMuteScopeV1Schema.safeParse({ kind: 'sender_session', sessionId: { selector: 'workers' } }).success).toBe(false);
    expect(FollowDeliveryMuteScopeV1Schema.safeParse({ kind: 'sender_session', sessionId: 'sender-a', accountId: 'other' }).success).toBe(false);
  });

  it('routes all three Actions to only the exact receiver and preserves DELETE scope', () => {
    const scope = { kind: 'sender_session' as const, sessionId: 'sender-a' };
    expect(resolveSessionFollowActionRequest('session.delivery.mute.set', {
      receiver: { kind: 'account' }, scope,
    })).toEqual({ method: 'PUT', path: '/v2/account/session-delivery-mutes', body: { scope } });
    expect(resolveSessionFollowActionRequest('session.delivery.mute.remove', {
      receiver: { kind: 'session', sessionId: 'receiver/a' }, scope,
    })).toEqual({ method: 'DELETE', path: '/v2/sessions/receiver%2Fa/delivery-mutes', body: { scope } });
    expect(resolveSessionFollowActionRequest('session.delivery.mute.list', {
      receiver: { kind: 'session', sessionId: 'receiver/a' },
    })).toEqual({ method: 'GET', path: '/v2/sessions/receiver%2Fa/delivery-mutes' });
  });

  it('keeps own Account preference safe while Session routing mutations remain danger', () => {
    const spec = getActionSpec('session.delivery.mute.set');
    expect(spec.safetyForInput?.({ receiver: { kind: 'account' } })).toBe('safe');
    expect(spec.safetyForInput?.({ receiver: { kind: 'session', sessionId: 'receiver' } })).toBe('danger');
    expect(spec.safetyForInput?.({ receiver: { kind: 'account', accountId: 'other' } })).toBe('danger');
    const context = { surface: 'agent' as const, authority: 'account_automation' as const };
    const scope = { kind: 'sender_session' as const, sessionId: 'sender' };
    expect(resolveActionApprovalRouting({ actionId: 'session.delivery.mute.set', spec, context,
      input: { receiver: { kind: 'account' }, scope } }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId: 'session.delivery.mute.set', spec, context,
      input: { receiver: { kind: 'session', sessionId: 'receiver' }, scope } }).required).toBe(true);
    const listId = 'session.delivery.mute.list';
    expect(resolveActionApprovalRouting({ actionId: listId, spec: getActionSpec(listId), context,
      input: { receiver: { kind: 'session', sessionId: 'receiver' } } }).required).toBe(false);
  });
});
