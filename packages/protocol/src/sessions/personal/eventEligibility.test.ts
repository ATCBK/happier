import { describe, expect, it } from 'vitest';

import {
  type SessionPersonalEventEligibilityInputV1,
  resolveSessionEffectiveNotificationV1,
  resolveSessionPersonalEventEligibilityV1,
} from './eventEligibility.js';

const TEAM_READER: SessionPersonalEventEligibilityInputV1 = {
  event: 'ready',
  isSessionOwner: false,
  accessible: true,
  accountSuspended: false,
  archived: false,
  responsible: false,
  tracked: false,
  targeted: false,
  followFacts: { follows: false, notificationLevel: null },
  capabilities: { canSubmitAgentInput: false, canApprovePermissions: false },
};

describe('resolveSessionEffectiveNotificationV1', () => {
  it('keeps the owner Important default without a stored preference', () => {
    expect(resolveSessionEffectiveNotificationV1({
      facts: { follows: false, notificationLevel: null },
      isSessionOwner: true,
    })).toEqual({ level: 'important', source: 'owner' });
  });

  it('lets an explicit preference win over the owner default', () => {
    expect(resolveSessionEffectiveNotificationV1({
      facts: { follows: true, notificationLevel: 'all_messages' },
      isSessionOwner: true,
    })).toEqual({ level: 'all_messages', source: 'preference' });
  });

  it('reports explicit suppression as a preference, not absence', () => {
    expect(resolveSessionEffectiveNotificationV1({
      facts: { follows: false, notificationLevel: 'none' },
      isSessionOwner: false,
    })).toEqual({ level: 'none', source: 'preference' });
  });

  it('gives a non-owner without a Follow row nothing', () => {
    expect(resolveSessionEffectiveNotificationV1({
      facts: { follows: false, notificationLevel: null },
      isSessionOwner: false,
    })).toEqual({ level: 'none', source: 'none' });
  });
});

describe('resolveSessionPersonalEventEligibilityV1', () => {
  it('admits an already-authorized rule selection without granting access or bypassing source suppression', () => {
    const rule = { ...TEAM_READER, admittedRulePolicies: [{ preset: 'important' as const }] };
    expect(resolveSessionPersonalEventEligibilityV1(rule)).toEqual({ eligible: true, reason: 'follow_policy' });
    expect(resolveSessionPersonalEventEligibilityV1({ ...rule, accessible: false })).toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...rule, archived: true })).toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...rule, accountSuspended: true })).toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...rule,
      followFacts: { follows: false, notificationLevel: 'none' },
    })).toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...rule, event: 'permission_required' })).toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...rule, event: 'permission_required',
      capabilities: { canSubmitAgentInput: false, canApprovePermissions: true },
    })).toEqual({ eligible: true, reason: 'follow_policy' });
    expect(resolveSessionPersonalEventEligibilityV1({ ...rule, event: 'message' })).toEqual({ eligible: false });
  });

  it('routes a committed one-shot winner only for its exact accepted occurrence', () => {
    const occurrence = { event: 'ready' as const, turnId: 'accepted-turn', agentStateVersion: 4, transcriptSeq: 10 };
    const reader = { ...TEAM_READER, targeted: true, onceOccurrence: occurrence,
      followFacts: { follows: false, notificationLevel: 'none' as const, onceDelivery: occurrence } };
    expect(resolveSessionPersonalEventEligibilityV1(reader)).toEqual({ eligible: true, reason: 'follow_once' });
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader, targeted: false })).toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader, onceOccurrence: { ...occurrence, turnId: 'next-turn' } }))
      .toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader, onceOccurrence: { ...occurrence, transcriptSeq: 11 } }))
      .toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader, accessible: false })).toEqual({ eligible: false });
  });
  it('uses semantic approval capability for an Action confirmation without granting question authority', () => {
    const reader = { ...TEAM_READER, event: 'user_action_required' as const, tracked: true,
      followFacts: { follows: true, notificationLevel: 'important' as const, policy: { preset: 'important' as const } },
      capabilities: { canSubmitAgentInput: false, canApprovePermissions: true } };
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader,
      followEvent: { kind: 'needs_you', type: 'approval' },
    })).toEqual({ eligible: true, reason: 'follow_policy' });
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader,
      followEvent: { kind: 'needs_you', type: 'decision' },
    })).toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader, tracked: false,
      followFacts: { follows: false, notificationLevel: 'none',
        once: { kind: 'first_needs_you' }, onceAfterAgentStateVersion: 1 },
      followEvent: { kind: 'needs_you', type: 'approval' },
      onceOccurrence: { event: 'permission_required', requestId: 'confirmation', agentStateVersion: 2 },
    })).toEqual({ eligible: true, reason: 'follow_once' });
  });
  it('admits the exact one-shot occurrence without turning suppression into ongoing interest', () => {
    const reader = { ...TEAM_READER, followFacts: {
      follows: false, notificationLevel: 'none' as const,
      once: { kind: 'turn_finished' as const, sourceTurnId: 'turn-a' }, onceAfterAgentStateVersion: 3,
    } };
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader,
      onceOccurrence: { event: 'ready', turnId: 'turn-a', agentStateVersion: 4 },
    })).toEqual({ eligible: true, reason: 'follow_once' });
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader,
      onceOccurrence: { event: 'ready', turnId: 'turn-b', agentStateVersion: 4 },
    })).toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader, event: 'message' })).toEqual({ eligible: false });
  });
  it('uses explicit Custom event selection instead of the legacy Important category list', () => {
    const reader = {
      ...TEAM_READER, tracked: true,
      followFacts: { follows: true, notificationLevel: 'important' as const,
        policy: { preset: 'custom' as const, events: { message: { delivery: 'quiet' as const } } } },
    };
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader, event: 'ready' })).toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader, event: 'message' })).toEqual({ eligible: true, reason: 'follow_policy' });
    expect(resolveSessionPersonalEventEligibilityV1({ ...reader, event: 'permission_required',
      capabilities: { canSubmitAgentInput: true, canApprovePermissions: true } })).toEqual({ eligible: false });
    const question = { ...reader, event: 'user_action_required' as const,
      followFacts: { ...reader.followFacts, policy: { preset: 'custom' as const,
        events: { needs_you: { blocked: { delivery: 'quiet' as const } } } } },
      capabilities: { canSubmitAgentInput: true, canApprovePermissions: false } };
    expect(resolveSessionPersonalEventEligibilityV1(question)).toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...question,
      followEvent: { kind: 'needs_you', type: 'blocked', mode: 'continue' },
    })).toEqual({ eligible: true, reason: 'follow_policy' });
  });

  it('never admits a Team reader on access alone', () => {
    for (const event of ['ready', 'failed', 'message', 'human_message'] as const) {
      expect(resolveSessionPersonalEventEligibilityV1({ ...TEAM_READER, event }))
        .toEqual({ eligible: false });
    }
  });

  it('admits a targeted assignment alert only through effective Follow notification', () => {
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      event: 'assigned',
      targeted: true,
      responsible: true,
      tracked: true,
      followFacts: { follows: true, notificationLevel: 'important', policy: { preset: 'important' as const } },
    })).toEqual({ eligible: true, reason: 'assignment_target' });
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      event: 'assigned',
      targeted: true,
      responsible: true,
    })).toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      event: 'assigned',
      targeted: true,
      responsible: true,
      tracked: true,
      followFacts: { follows: true, notificationLevel: 'none' },
    })).toEqual({ eligible: false });
  });

  it('admits one targeted direct-share fact without tracking', () => {
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      event: 'directly_shared',
      targeted: true,
    })).toEqual({ eligible: true, reason: 'direct_share_target' });
  });

  it('admits a targeted discussion mention without creating a subscription', () => {
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      event: 'discussion_mention',
      targeted: true,
    })).toEqual({ eligible: true, reason: 'discussion_mention_target' });
  });

  it('rejects an untargeted mention event', () => {
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      event: 'discussion_mention',
      targeted: false,
    })).toEqual({ eligible: false });
  });

  it('keeps the owner Important default for ready and failed events', () => {
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      event: 'failed',
      isSessionOwner: true,
      tracked: true,
    })).toEqual({ eligible: true, reason: 'owner_important' });
  });

  it('admits Important Follow for ready but not for an ordinary message', () => {
    const important: SessionPersonalEventEligibilityInputV1 = {
      ...TEAM_READER,
      tracked: true,
      followFacts: { follows: true, notificationLevel: 'important', policy: { preset: 'important' as const } },
    };
    expect(resolveSessionPersonalEventEligibilityV1(important))
      .toEqual({ eligible: true, reason: 'follow_policy' });
    expect(resolveSessionPersonalEventEligibilityV1({ ...important, event: 'message' }))
      .toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...important, event: 'human_message' }))
      .toEqual({ eligible: true, reason: 'follow_policy' });
  });

  it('admits every permitted material message only at all_messages', () => {
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      event: 'message',
      tracked: true,
      followFacts: { follows: true, notificationLevel: 'all_messages', policy: { preset: 'everything' as const } },
    })).toEqual({ eligible: true, reason: 'follow_policy' });
  });

  it('keeps a following collaborator with notifications off out of every ongoing event', () => {
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      tracked: true,
      followFacts: { follows: true, notificationLevel: 'none' },
    })).toEqual({ eligible: false });
  });

  it('does not let responsibility bypass an explicit Unfollow', () => {
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      responsible: true,
      tracked: false,
      followFacts: { follows: false, notificationLevel: 'none' },
    })).toEqual({ eligible: false });
  });

  it('admits a targeted capable action request without ongoing tracking', () => {
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      event: 'permission_required',
      targeted: true,
      capabilities: { canSubmitAgentInput: false, canApprovePermissions: true },
    })).toEqual({ eligible: true, reason: 'targeted_capable_action' });
  });

  it('never broadcasts an action request to a capable but untargeted, unfollowed reader', () => {
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      event: 'user_action_required',
      capabilities: { canSubmitAgentInput: true, canApprovePermissions: true },
    })).toEqual({ eligible: false });
  });

  it('drops an action request when the Account can no longer perform it', () => {
    expect(resolveSessionPersonalEventEligibilityV1({
      ...TEAM_READER,
      event: 'user_action_required',
      tracked: true,
      followFacts: { follows: true, notificationLevel: 'important', policy: { preset: 'important' as const } },
      capabilities: { canSubmitAgentInput: false, canApprovePermissions: false },
    })).toEqual({ eligible: false });
  });

  it('stops every event on lost access, suspension, and archive', () => {
    const owner: SessionPersonalEventEligibilityInputV1 = {
      ...TEAM_READER,
      isSessionOwner: true,
      tracked: true,
    };
    expect(resolveSessionPersonalEventEligibilityV1({ ...owner, accessible: false }))
      .toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...owner, accountSuspended: true }))
      .toEqual({ eligible: false });
    expect(resolveSessionPersonalEventEligibilityV1({ ...owner, archived: true }))
      .toEqual({ eligible: false });
  });
});
