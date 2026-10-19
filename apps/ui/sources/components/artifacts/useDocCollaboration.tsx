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
import type { AdmittedDocRead } from './ArtifactEditProposal';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import { buildDocPassageMargin, readDocPassageThreadQuote } from './docPassageMargin';
import { showArtifactHistorySheet } from './ArtifactHistorySheet';
import { useDocPassageThreads } from './useDocPassageThreads';
import { readDocAudience, type DocAudience } from './docAudience';
import { rememberDocReturn } from './docThreadReturn';

/** One thread in the Doc's comment list: the passage it is about and who started it. */
export type DocThreadListItem = Readonly<{
  id: string;
  quote: string;
  author: string;
  replies: number;
  changed: boolean;
}>;

export type DocCollaboration = Readonly<{
  /** `doc.read`'s authorized count; `null` while unknown or unavailable, never a guessed zero. */
  openCommentCount: number | null;
  /** The version being read, from `doc.read`; `null` until it answers. */
  version: number | null;
  /** Who the Doc reaches; `null` while unknown (the header then says nothing about it). */
  audience: DocAudience | null;
  threads: readonly DocThreadListItem[];
  /** Beside the passages: focus the thread there. Without a margin: open it. */
  selectThread: (id: string) => void;
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
    membership: readonly DiscussionOpenedSummaryV1[];
    read: AdmittedDocRead;
  }> | null>(null);
  const [audience, setAudience] = React.useState<Readonly<{
    key: string;
    value: DocAudience | null;
  }> | null>(null);
  const marginShown = React.useRef(false);
  const reportShown = React.useCallback((shown: boolean) => {
    marginShown.current = shown;
  }, []);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const artifactId = prose?.id ?? null;

  React.useEffect(() => {
    if (!client || !artifactId || read.status !== 'ready' || !read.membership) return;
    let current = true;
    const key = JSON.stringify([scope?.serverId, scope?.accountId, artifactId, revisionKey]);
    const membership = read.membership;
    void client
      .readDoc({ ref: { kind: 'doc', artifactId } })
      .then((outcome) => {
        if (current)
          setCount({
            key,
            membership,
            read: outcome.ok ? { status: 'ready', value: outcome.value } : { status: 'unavailable' },
          });
      });
    return () => {
      current = false;
    };
  }, [artifactId, client, revisionKey, read.status, read.membership, scope]);

  const docRead: AdmittedDocRead = React.useMemo(() => {
    if (read.status !== 'ready') return { status: read.status === 'loading' ? 'loading' : 'unavailable' };
    const key = JSON.stringify([scope?.serverId, scope?.accountId, artifactId, revisionKey]);
    return count?.key === key && count.membership === read.membership ? count.read : { status: 'loading' };
  }, [artifactId, count, read.membership, read.status, revisionKey, scope]);

  const ownerAccountId = prose?.ownerAccountId;
  const access = prose?.access;
  const publicAudience = prose?.publicAudience;
  React.useEffect(() => {
    if (!client || !artifactId) return;
    let current = true;
    void readDocAudience({
      current: { artifactId, header: {}, ownerAccountId, access, publicAudience },
      readGrants: async () => {
        const outcome = await client.listAccessGrants(artifactId);
        if (!outcome.ok) throw new Error(outcome.failure.code);
        return outcome.value;
      },
    }).then((value) => {
      if (current) setAudience({ key: artifactId, value });
    });
    return () => {
      current = false;
    };
  }, [access, artifactId, client, ownerAccountId, publicAudience, revisionKey]);

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
  // A changed passage opens History on the version its comment was written against, compared with now.
  const openHistory = React.useCallback((compareFromBodyVersion: number) => {
    if (artifactId)
      showArtifactHistorySheet({ artifactId, name: proseName, canRestore, compareFromBodyVersion });
  }, [artifactId, canRestore, proseName]);
  const open = React.useCallback(
    (discussionId: string) => {
      if (!scope) return;
      // Back from the thread returns to this passage in this Doc.
      if (artifactId) rememberDocReturn(artifactId);
      router.push(
        buildDiscussionRouteHref({
          target: {
            kind: 'discussion',
            address: { serverId: scope.serverId },
            discussionId,
          },
          ...(artifactId ? { returnArtifactId: artifactId } : {}),
        }) as Href,
      );
    },
    [artifactId, router, scope],
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
          docRead={docRead}
          mountThread={read.mountThread}
          viewerAccountId={scope.accountId}
          onFocus={() => setFocusedId(id)}
          onOpen={() => open(id)}
          onOpenHistory={openHistory}
        />
      );
    },
    [client, docRead, focusedId, open, openHistory, read.mountThread, scope, threads],
  );

  const accepted = React.useMemo(() => {
    const value = model?.accepted;
    if (!value || !scope) return null;
    const proposal =
      model.threads.find(
        (thread) =>
          thread.acceptedProposal?.docEditProposalDispositionV1?.state === 'accepted' &&
          thread.acceptedProposal.docEditProposalDispositionV1.decidedBy.atMs ===
            value.atMs,
      )?.acceptedProposal ?? null;
    const proposer = proposal
      ? resolveDiscussionMessageAuthorLabel(proposal)
      : t('session.collaboration.discussion.collaborator');
    const label =
      value.deciderAccountId === scope.accountId
        ? t('artifacts.browser.passage.youAccepted', { name: proposer })
        : t('artifacts.browser.passage.accepted', { name: proposer });
    return { label, atMs: value.atMs };
  }, [model, scope]);

  const viewerAccountId = scope?.accountId ?? null;
  const list = React.useMemo<readonly DocThreadListItem[]>(
    () =>
      (threads ?? []).map((thread) => ({
        id: thread.discussionId,
        quote: readDocPassageThreadQuote(thread),
        author:
          thread.root.authorAccountId === viewerAccountId
            ? t('artifacts.browser.passage.you')
            : resolveDiscussionMessageAuthorLabel(thread.root),
        // The suggested edit has its own line on the card; replies are what people wrote back.
        replies: thread.replies.filter((reply) => reply !== thread.proposal).length,
        changed: thread.location.state === 'detached',
      })),
    [threads, viewerAccountId],
  );
  const selectThread = React.useCallback(
    (id: string) => {
      if (marginShown.current) setFocusedId(id);
      else open(id);
    },
    [open],
  );
  const margin = React.useMemo<ArtifactPassageMargin>(
    () => ({
      passages,
      focusedId,
      onFocus: setFocusedId,
      onOpen: open,
      renderCard,
      reportShown,
    }),
    [focusedId, open, passages, renderCard, reportShown],
  );
  if (!prose || !scope) return null;
  return {
    openCommentCount: docRead.status === 'ready' ? docRead.value.openCommentCount : null,
    version: docRead.status === 'ready' ? docRead.value.artifact.revision.bodyVersion : null,
    audience: audience && audience.key === prose.id ? audience.value : null,
    threads: list,
    selectThread,
    accepted,
    margin,
  };
}
