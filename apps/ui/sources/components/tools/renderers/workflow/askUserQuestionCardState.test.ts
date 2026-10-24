import { describe, expect, it } from 'vitest';

import type { ToolCall } from '@happier-dev/session-core/messages';
import { t } from '@/text';

import {
  isQuestionRoutedToManager,
  resolveAskUserQuestionFooterHint,
  resolveAskUserQuestionLead,
  resolveAskUserQuestionAnsweredByLabel,
} from './askUserQuestionCardState';

describe('resolveAskUserQuestionAnsweredByLabel', () => {
  const profile = { name: null, firstName: null, lastName: null, username: null, avatarUrl: null };
  it.each([
    { serverId: 'home', accountId: 'other', profile, nameKey: 'message.accountActorUnnamedMember' },
    { serverId: 'home', accountId: 'other', profile: null, nameKey: 'message.accountActorFormerMember' },
    { serverId: 'other-home', accountId: 'self', profile, nameKey: 'message.accountActorUnnamedMember' },
    { serverId: 'home', accountId: 'self', profile: null, nameKey: 'message.accountActorFormerMember' },
  ] as const)('uses the shared Account name for $serverId / $accountId / $nameKey', actor => {
    expect(resolveAskUserQuestionAnsweredByLabel({ answeredBy: { kind: 'person', accountId: actor.accountId },
      serverId: actor.serverId, viewerScope: { serverId: 'home', accountId: 'self' },
      answeringAccountActor: { ...actor, v: 1 } })).toBe(t('workflows.run.answeredBy', { name: t(actor.nameKey) }));
  });
  it('retains the self sentence and keeps an unknown person distinct from a known unnamed Account', () => {
    expect(resolveAskUserQuestionAnsweredByLabel({ answeredBy: { kind: 'person', accountId: 'self' }, serverId: 'home',
      viewerScope: { serverId: 'home', accountId: 'self' }, answeringAccountActor: { v: 1, serverId: 'home', accountId: 'self', profile } }))
      .toBe(t('workflows.run.answeredByYou'));
    expect(resolveAskUserQuestionAnsweredByLabel({ answeredBy: { kind: 'person' } })).toBe(t('workflows.run.answeredByPerson'));
  });
});

describe('resolveAskUserQuestionLead', () => {
  it('says a non-blocking question keeps going on its stated assumption', () => {
    expect(
      resolveAskUserQuestionLead({
        questionV1: {
          mode: 'continue',
          assumption: 'Continuing with 409',
          lasting: false,
        },
        handler: null,
      }),
    ).toEqual({ kind: 'not_blocking', assumption: 'Continuing with 409' });
  });

  it('names the manager handling the question and stays quiet while it is reachable', () => {
    expect(
      resolveAskUserQuestionLead({
        questionV1: { mode: 'wait', lasting: false },
        handler: { name: 'Daily coordinator', availability: 'online' },
      }),
    ).toEqual({ kind: 'handler', name: 'Daily coordinator', away: null });
  });

  it('hands a question back to the person when its manager is stopped or offline', () => {
    expect(
      resolveAskUserQuestionLead({
        questionV1: {
          mode: 'continue',
          assumption: 'Using 409',
          lasting: false,
        },
        handler: { name: 'Daily coordinator', availability: 'stopped' },
      }),
    ).toEqual({ kind: 'handler', name: 'Daily coordinator', away: 'stopped' });
    expect(
      resolveAskUserQuestionLead({
        questionV1: { mode: 'wait', lasting: false },
        handler: { name: 'Daily coordinator', availability: 'offline' },
      }),
    ).toEqual({ kind: 'handler', name: 'Daily coordinator', away: 'offline' });
  });

  it('adds no lead line for an ordinary waiting question or a native one without question facts', () => {
    expect(
      resolveAskUserQuestionLead({
        questionV1: { mode: 'wait', lasting: true },
        handler: null,
      }),
    ).toBeNull();
    expect(
      resolveAskUserQuestionLead({ questionV1: undefined, handler: null }),
    ).toBeNull();
  });
});

describe('resolveAskUserQuestionFooterHint', () => {
  it('counts progress while a multi-question request is incomplete', () => {
    expect(
      resolveAskUserQuestionFooterHint({ mode: 'wait', total: 2, answered: 1 }),
    ).toEqual({ kind: 'progress', answered: 1, total: 2 });
  });

  it('states the consequence of answering once every question has an answer', () => {
    expect(
      resolveAskUserQuestionFooterHint({ mode: 'wait', total: 2, answered: 2 }),
    ).toEqual({ kind: 'starts_next_turn' });
    expect(
      resolveAskUserQuestionFooterHint({
        mode: 'continue',
        total: 1,
        answered: 0,
      }),
    ).toEqual({ kind: 'next_step' });
    // A native question carries no mode: the provider's own tool always waits.
    expect(
      resolveAskUserQuestionFooterHint({
        mode: undefined,
        total: 1,
        answered: 0,
      }),
    ).toEqual({ kind: 'starts_next_turn' });
  });
});

describe('isQuestionRoutedToManager', () => {
  const question = (permission?: ToolCall['permission']): ToolCall =>
    ({ id: 'q1', name: 'AskUserQuestion', state: 'running', input: {}, createdAt: 1, startedAt: 1, completedAt: null, description: null, result: null, permission }) as ToolCall;
  const request = (currentHandler: unknown) => ({ tool: 'AskUserQuestion', arguments: {}, currentHandler });

  it('is true while a manager Session handles it, and once a manager answered it', () => {
    expect(isQuestionRoutedToManager({ tool: question(), agentState: { requests: { q1: request({ kind: 'session', sessionId: 'manager-1' }) } } as never })).toBe(true);
    expect(isQuestionRoutedToManager({ tool: question({ id: 'q1', status: 'approved', answeredBy: { kind: 'session', sessionId: 'manager-1' } }), agentState: null })).toBe(true);
  });

  it('is false for a question the person handles or answered', () => {
    expect(isQuestionRoutedToManager({ tool: question(), agentState: { requests: { q1: request({ kind: 'person' }) } } as never })).toBe(false);
    expect(isQuestionRoutedToManager({ tool: question({ id: 'q1', status: 'approved', answeredBy: { kind: 'person' } }), agentState: null })).toBe(false);
    expect(isQuestionRoutedToManager({ tool: question(), agentState: null })).toBe(false);
  });
});
