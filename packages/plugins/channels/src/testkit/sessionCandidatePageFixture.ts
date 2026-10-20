import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginUiActionResultFor } from '@happier-dev/plugin-sdk/ui';

type AwarenessPage = Extract<PluginUiActionResultFor<'session.list'>, Readonly<{ view: 'awareness' }>>;

/** The transcript-free host result existing-Session pickers request. */
export function createSessionCandidatePageFixture(page: Readonly<{
  sessions: readonly Readonly<{ id: string; title?: string }>[];
  nextCursor?: string | null;
}>): AwarenessPage & JsonValue {
  return {
    view: 'awareness', projectionVersion: 1,
    sessions: page.sessions.map(({ id, title }) => ({
      v: 1, sessionId: id, ...(title ? { title } : {}),
      lifecycle: 'active', runtime: 'idle', freshness: 'live',
      operational: { primary: 'none', reasons: [] },
      encryption: 'plain', availability: 'complete',
    })),
    nextCursor: page.nextCursor ?? null,
    hasNext: Boolean(page.nextCursor),
  };
}
