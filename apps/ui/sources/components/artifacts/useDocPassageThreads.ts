import * as React from 'react';
import type {
  DiscussionOpenedMessageV1,
  DiscussionOpenedSummaryV1,
} from '@happier-dev/protocol/discussions/actions';

import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import type {
  DiscussionRepository,
  DiscussionRepositorySnapshot,
} from '@/sync/ops/discussions/discussionRepository';

export type DocPassageThreadsRead = Readonly<{
  status: 'loading' | 'ready' | 'unavailable';
  threads: readonly Readonly<{
    discussionId: string;
    summary: DiscussionOpenedSummaryV1;
    messages: readonly DiscussionOpenedMessageV1[];
  }>[];
}>;

const UNAVAILABLE: DocPassageThreadsRead = Object.freeze({
  status: 'unavailable',
  threads: Object.freeze([]),
});
const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

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
  const snapshot: DiscussionRepositorySnapshot | null =
    React.useSyncExternalStore(
      repository?.subscribe ?? emptySubscribe,
      repository?.getSnapshot ?? emptySnapshot,
      repository?.getSnapshot ?? emptySnapshot,
    );
  React.useEffect(() => repository?.mount(), [repository]);
  const [discovery, setDiscovery] = React.useState<Readonly<{
    key: string;
    ids: readonly string[] | null;
  }> | null>(null);
  const key = `${input.serverId}:${input.artifactId}`;

  React.useEffect(() => {
    if (!client || !repository) return;
    const controller = new AbortController();
    void (async () => {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await repository.readList(
          {
            state: 'active',
            anchorDocArtifactId: input.artifactId,
            ...(cursor ? { cursor } : {}),
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (page.kind !== 'succeeded') {
          // Keep what was last read; an unreadable list is unavailable, never "no comments".
          setDiscovery((previous) =>
            previous?.key === key ? previous : { key, ids: null },
          );
          return;
        }
        ids.push(
          ...page.value.discussions.filter(
            (row) =>
              row.anchor?.kind === 'doc' &&
              row.anchor.doc.ref.artifactId === input.artifactId,
          ).map(row => row.id),
        );
        if (!page.value.nextCursor || page.value.nextCursor === cursor) break;
        cursor = page.value.nextCursor;
      }
      setDiscovery({ key, ids });
      await Promise.all(
        ids.map((discussionId) =>
          repository
            .refreshMessages(discussionId, controller.signal)
            .catch(() => undefined),
        ),
      );
    })();
    return () => controller.abort();
  }, [client, input.artifactId, input.refreshKey, key, repository]);

  return React.useMemo(() => {
    if (!usable) return UNAVAILABLE;
    if (!discovery || discovery.key !== key)
      return { status: 'loading', threads: [] };
    if (discovery.ids === null) return UNAVAILABLE;
    const threads: DocPassageThreadsRead['threads'][number][] = [];
    for (const discussionId of discovery.ids) {
      const thread = snapshot?.threads[discussionId];
      if (!thread?.summary || thread.status === 'revoked' || thread.status === 'locked') return UNAVAILABLE;
      threads.push({ discussionId, summary: thread.summary, messages: thread.messages });
    }
    return {
      status: 'ready',
      threads,
    };
  }, [discovery, key, snapshot?.threads, usable]);
}
