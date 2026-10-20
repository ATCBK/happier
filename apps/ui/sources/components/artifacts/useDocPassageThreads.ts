import * as React from 'react';
import type {
  DiscussionOpenedMessageV1,
  DiscussionOpenedSummaryV1,
} from '@happier-dev/protocol/discussions/actions';

import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import type { DiscussionRepository } from '@/sync/ops/discussions/discussionRepository';
import { useDiscussionDocSnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';

export type DocPassageThreadsRead = Readonly<{
  status: 'loading' | 'ready' | 'unavailable';
  membership: readonly DiscussionOpenedSummaryV1[] | null;
  mountThread: (discussionId: string) => () => void;
  threads: readonly Readonly<{
    discussionId: string;
    summary: DiscussionOpenedSummaryV1;
    messages: readonly DiscussionOpenedMessageV1[];
  }>[];
}>;

const UNAVAILABLE: DocPassageThreadsRead = Object.freeze({
  status: 'unavailable',
  membership: null,
  mountThread: () => () => {},
  threads: Object.freeze([]),
});

/**
 * The passage threads of one Doc in its Home: C3's Doc-scoped list (`discussion.list` with
 * `anchorDocArtifactId`, which carries each opened passage root) and each thread's messages through
 * the one shared Discussion repository, so the margin, the full Discussion and the Inbox read the
 * same messages, dispositions and optimistic posts.
 */
export function useDocPassageThreads(
  input: Readonly<{ serverId: string; artifactId: string; refreshKey: string }>,
): DocPassageThreadsRead {
  const serverIds = React.useMemo(() => [input.serverId], [input.serverId]);
  const bindings = useServerCredentialAccountScopeBindings(serverIds);
  const binding = [...bindings.values()][0] ?? null;
  const availability = useSessionCollaborationAvailability(input.serverId);
  const usable = input.artifactId !== '' && binding?.isCurrent() === true && availability === 'available';
  const client = React.useMemo(
    () =>
      usable && binding
        ? createDiscussionClient({
            scope: binding.scope,
            availability: 'available',
          })
        : null,
    [binding, usable],
  );
  const repository: DiscussionRepository | null = React.useMemo(
    () =>
      client && binding
        ? getDiscussionRepository({
            scope: binding.scope,
            address: { serverId: binding.scope.serverId },
            client,
            accountLifetime: binding,
          })
        : null,
    [binding, client],
  );
  const snapshot = useDiscussionDocSnapshot(repository, input.artifactId);
  React.useEffect(() => {
    if (!repository) return;
    const controller = new AbortController();
    const release = repository.mount({ anchorDocArtifactId: input.artifactId });
    void repository.refreshDocList(input.artifactId, controller.signal);
    return () => { controller.abort(); release(); };
  }, [input.artifactId, input.refreshKey, repository]);

  const mountThread = React.useCallback((discussionId: string) => {
    if (!repository) return () => {};
    const release = repository.mount({ discussionId });
    void repository.refreshDiscussion(discussionId);
    return release;
  }, [repository]);

  return React.useMemo(() => {
    if (!usable) return UNAVAILABLE;
    const query = snapshot?.query;
    if (!query || query.status === 'idle' || query.status === 'loading')
      return { status: 'loading', threads: [], membership: null, mountThread };
    if (query.status !== 'ready' || query.incomplete || query.nextCursor !== null) return UNAVAILABLE;
    const threads: DocPassageThreadsRead['threads'][number][] = [];
    for (const summary of query.items) {
      const discussionId = summary.id;
      const thread = snapshot?.threads[discussionId];
      if (!thread?.summary || thread.revoked
        || !thread.messages.find(message => message.seq === 1)?.content) return UNAVAILABLE;
      if (thread.summary.archivedAt !== null) continue;
      threads.push({ discussionId, summary: thread.summary, messages: thread.messages });
    }
    return {
      status: 'ready',
      threads,
      membership: query.items,
      mountThread,
    };
  }, [input.artifactId, mountThread, repository, snapshot, usable]);
}
