import * as React from 'react';

import {
  useRouter,
  type Href,
} from '@/components/appShell/workspace/destinationRoute';
import { buildDiscussionRouteHref } from '@/components/discussions/discussionRoutes';
import { resolveDiscussionMessageAuthorLabel } from '@/components/discussions/discussionTimelineProjection';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { createArtifactActionsClient } from './artifactActionsClient';
import { readArtifactCodeLanguage } from './artifactBrowserModel';
import type { ArtifactPassageMargin } from './ArtifactPassageSelection';
import { ArtifactPassageThreadCard } from './ArtifactPassageThreadCard';
import { buildDocPassageMargin } from './docPassageMargin';
import { showArtifactHistorySheet } from './ArtifactHistorySheet';
import { useDocPassageThreads } from './useDocPassageThreads';

export type DocCollaboration = Readonly<{
  /** `doc.read`'s authorized count; `null` while unknown or unavailable, never a guessed zero. */
  openCommentCount: number | null;
  firstThreadId: string | null;
  openFirstThread: () => void;
  /** The suggestion accepted into the version being read, named for the header. */
  accepted: Readonly<{ label: string; atMs: number }> | null;
  margin: ArtifactPassageMargin;
}>;

/**
 * Comments and suggested edits on a Doc (C5 L8): the passage threads placed against the version
 * being read, the header's comment count and accepted-edit line, and the margin's thread cards.
 * `null` for anything that is not a prose Doc read at a known version.
 */
export function useDocCollaboration(
  artifact: DecryptedArtifact | null,
): DocCollaboration | null {
  const scope = useActiveServerAccountScope();
  const prose =
    artifact !== null &&
    artifact.isDecrypted !== false &&
    typeof artifact.body === 'string' &&
    artifact.body.length > 0 &&
    artifact.bodyVersion !== undefined &&
    !readArtifactCodeLanguage(artifact)
      ? artifact
      : null;
  const revisionKey = prose
    ? `${prose.headerVersion}.${prose.bodyVersion}`
    : '';
  const read = useDocPassageThreads({
    serverId: scope?.serverId ?? '',
    artifactId: prose?.id ?? '',
    refreshKey: revisionKey,
  });
  const client = React.useMemo(
    () => (scope ? createArtifactActionsClient(scope) : null),
    [scope],
  );
  const router = useRouter();
  const [count, setCount] = React.useState<Readonly<{
    key: string;
    value: number | null;
  }> | null>(null);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const artifactId = prose?.id ?? null;

  React.useEffect(() => {
    if (!client || !artifactId) return;
    let current = true;
    const key = `${artifactId}:${revisionKey}`;
    void client
      .readDoc({ ref: { kind: 'doc', artifactId } })
      .then((outcome) => {
        if (current)
          setCount({
            key,
            value: outcome.ok ? outcome.value.openCommentCount : null,
          });
      });
    return () => {
      current = false;
    };
  }, [artifactId, client, revisionKey]);

  const model = React.useMemo(
    () =>
      prose && read.status === 'ready' && prose.bodyVersion !== undefined
        ? buildDocPassageMargin({
            source: prose.body as string,
            revision: {
              headerVersion: prose.headerVersion,
              bodyVersion: prose.bodyVersion,
            },
            threads: read.threads,
          })
        : null,
    [prose, read],
  );
  const canRestore =
    prose !== null &&
    (prose.access === undefined ||
      prose.access === 'owner' ||
      prose.access === 'edit' ||
      prose.access === 'admin');
  const proseName = prose?.title || t('artifacts.untitled');
  const openHistory = React.useCallback(() => {
    if (artifactId)
      showArtifactHistorySheet({ artifactId, name: proseName, canRestore });
  }, [artifactId, canRestore, proseName]);
  const open = React.useCallback(
    (discussionId: string) => {
      if (!scope) return;
      router.push(
        buildDiscussionRouteHref({
          target: {
            kind: 'discussion',
            address: { serverId: scope.serverId },
            discussionId,
          },
        }) as Href,
      );
    },
    [router, scope],
  );

  const threads = model?.threads;
  const passages = React.useMemo(
    () =>
      (threads ?? []).map((thread) => ({
        id: thread.discussionId,
        location: thread.location,
      })),
    [threads],
  );
  const renderCard = React.useCallback(
    (id: string) => {
      const thread = threads?.find(
        (candidate) => candidate.discussionId === id,
      );
      if (!thread || !client || !scope) return null;
      return (
        <ArtifactPassageThreadCard
          thread={thread}
          focused={focusedId === id}
          client={client}
          viewerAccountId={scope.accountId}
          onFocus={() => setFocusedId(id)}
          onOpen={() => open(id)}
          onOpenHistory={openHistory}
        />
      );
    },
    [client, focusedId, open, openHistory, scope, threads],
  );

  const accepted = React.useMemo(() => {
    const value = model?.accepted;
    if (!value || !scope) return null;
    const proposal =
      model.threads.find(
        (thread) =>
          thread.proposal?.docEditProposalDispositionV1?.state === 'accepted' &&
          thread.proposal.docEditProposalDispositionV1.decidedBy.atMs ===
            value.atMs,
      )?.proposal ?? null;
    const proposer = proposal
      ? resolveDiscussionMessageAuthorLabel(proposal)
      : t('session.collaboration.discussion.collaborator');
    const label =
      value.deciderAccountId === scope.accountId
        ? t('artifacts.browser.passage.youAccepted', { name: proposer })
        : t('artifacts.browser.passage.accepted', { name: proposer });
    return { label, atMs: value.atMs };
  }, [model, scope]);

  const firstThreadId = threads?.[0]?.discussionId ?? null;
  const margin = React.useMemo<ArtifactPassageMargin>(
    () => ({
      passages,
      focusedId,
      onFocus: setFocusedId,
      onOpen: open,
      renderCard,
    }),
    [focusedId, open, passages, renderCard],
  );
  if (!prose || !scope) return null;
  return {
    openCommentCount:
      count && count.key === `${prose.id}:${revisionKey}` ? count.value : null,
    firstThreadId,
    openFirstThread: () => {
      if (firstThreadId) open(firstThreadId);
    },
    accepted,
    margin,
  };
}
