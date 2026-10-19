import { describe, expect, it } from 'vitest';

import {
  ListSessionFollowSourcesResponseSchema,
  RemoveSessionFollowSourceResponseSchema,
  SESSION_FOLLOW_SOURCES_ERROR_CODES_V1,
  SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1,
  SessionFollowSourceV1Schema,
  SetSessionFollowSourceRequestSchema,
  SetSessionFollowSourceResponseSchema,
} from './sessionFollowSourcesApi.js';

const source = {
  sourceSessionId: 'src-session',
  destinationSessionId: 'dst-session',
  policy: { preset: 'important' as const },
  deliveryState: 'eligible' as const,
  hasPendingUpdates: true,
};

describe('session Follow sources authoring contracts', () => {
  it('accepts the canonical source projection and rejects unknown fields', () => {
    expect(SessionFollowSourceV1Schema.parse(source)).toEqual(source);
    expect(SessionFollowSourceV1Schema.safeParse({
      sourceSessionId: source.sourceSessionId,
      destinationSessionId: source.destinationSessionId,
      deliveryState: source.deliveryState,
    }).success).toBe(false);
    expect(SessionFollowSourceV1Schema.safeParse({ ...source, deliveryAccountId: 'acc' }).success).toBe(false);
  });

  it('requires one explicit shared event policy instead of a separate source mode', () => {
    expect(SetSessionFollowSourceRequestSchema.parse({ policy: source.policy })).toEqual({ policy: source.policy });
    expect(SetSessionFollowSourceRequestSchema.safeParse({}).success).toBe(false);
    expect(SetSessionFollowSourceRequestSchema.safeParse({ mode: 'next_turn' }).success).toBe(false);
    expect(SetSessionFollowSourceRequestSchema.safeParse({ policy: source.policy, mode: 'wake_on_human_change' }).success).toBe(false);
  });

  it('rejects a delivery state that is not durably derivable from the two endpoints', () => {
    expect(SessionFollowSourceV1Schema.safeParse({ ...source, deliveryState: 'waiting_for_runtime' }).success).toBe(false);
    expect(SessionFollowSourceV1Schema.parse({ ...source, deliveryState: 'paused_archived' }).deliveryState)
      .toBe('paused_archived');
  });

  it('carries the pair-specific rejections alongside the shared Follow codes', () => {
    expect(SESSION_FOLLOW_SOURCES_ERROR_CODES_V1).toContain('session_follow_same_session');
    expect(SESSION_FOLLOW_SOURCES_ERROR_CODES_V1).toContain('session_follow_source_forbidden');
    expect(SESSION_FOLLOW_SOURCES_ERROR_CODES_V1).toContain('feature_unavailable');
    expect(new Set(SESSION_FOLLOW_SOURCES_ERROR_CODES_V1).size).toBe(SESSION_FOLLOW_SOURCES_ERROR_CODES_V1.length);
  });

  it('keeps removal idempotent and set responses carrying the stored projection', () => {
    expect(RemoveSessionFollowSourceResponseSchema.parse({ changed: false })).toEqual({ changed: false });
    expect(SetSessionFollowSourceResponseSchema.parse({ changed: true, source }).source).toEqual(source);
    expect(ListSessionFollowSourcesResponseSchema.parse({ sources: [] }).sources).toEqual([]);
  });

  it('nests the resource under the destination Session and exposes no delivery path', () => {
    expect(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.list).toBe('/v2/sessions/:destinationSessionId/follows/sessions');
    expect(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.source)
      .toBe('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId');
    for (const path of Object.values(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1)) {
      expect(path).not.toMatch(/\/(prepare|repair|wake|status|deliver)\b/);
    }
  });
});
