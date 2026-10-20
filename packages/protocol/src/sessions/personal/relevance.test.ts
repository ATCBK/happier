import { describe, expect, it } from 'vitest';
import { NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1, resolveSessionPersonalRelevanceV1 as resolveRelevance } from './relevance.js';

it('keeps a private one-shot in My work without claiming ongoing Follow', () => {
  expect(resolveRelevance({ ...NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1, followOnce: true }))
    .toEqual({ relevant: true, reasons: ['follow_once'] });
});

import {
  NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1,
  resolveSessionPersonalRelevanceV1,
} from './relevance.js';

describe('resolveSessionPersonalRelevanceV1', () => {
  it('is quiet when only broad Team/Group access exists', () => {
    expect(resolveSessionPersonalRelevanceV1(NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1))
      .toEqual({ relevant: false, reasons: [] });
  });

  it('reports one row with every overlapping reason in canonical order', () => {
    expect(resolveSessionPersonalRelevanceV1({
      ...NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1,
      pinnedByMe: true,
      ownedByMe: true,
      followedByMe: true,
      responsibleForMe: true,
    })).toEqual({
      relevant: true,
      reasons: ['owned_by_me', 'responsible_for_me', 'followed_by_me', 'pinned_by_me'],
    });
  });

  it('treats an explicit positive attention standing as relevance', () => {
    expect(resolveSessionPersonalRelevanceV1({
      ...NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1,
      explicitAttention: true,
    })).toEqual({ relevant: true, reasons: ['explicit_attention'] });
  });

  it('keeps a genuine direct share relevant without any tracking fact', () => {
    expect(resolveSessionPersonalRelevanceV1({
      ...NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1,
      sharedDirectlyWithMe: true,
    })).toEqual({ relevant: true, reasons: ['shared_directly_with_me'] });
  });

  it('separates authenticated human authorship from a sparse discussion mention', () => {
    expect(resolveSessionPersonalRelevanceV1({
      ...NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1,
      authoredByMe: true,
      mentionedInDiscussion: true,
    })).toEqual({
      relevant: true,
      reasons: ['authored_by_me', 'mentioned_in_discussion'],
    });
  });
});
