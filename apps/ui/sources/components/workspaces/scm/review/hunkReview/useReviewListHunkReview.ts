import * as React from 'react';

import { useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ReviewBlockHunkReview } from '../ChangedFilesReviewDiffBlock';
import { useHunkDiscard } from './useHunkDiscard';

/**
 * Keep / Discard for the Review list over the live checkout (Uncommitted): every rendered file's rows share
 * this source and the one discard owner. `discard: false` (no write capability) offers Keep only.
 */
export function useReviewListHunkReview(
  input: Readonly<{
    scope: WorkspaceScopeBase;
    sessionId?: string | null;
    agentName?: string | null;
    discard: boolean;
    refresh: () => void;
  }>,
): ReviewBlockHunkReview {
  const reachability = useCheckoutReachability(input.scope);
  const sessionId = input.sessionId?.trim() || null;
  const hunkDiscard = useHunkDiscard({
    scope: input.scope,
    sessionId,
    agentName: input.agentName,
    machineName: reachability.machineName,
    unreachable: reachability.unreachable,
    refresh: input.refresh,
  });
  const host = React.useMemo(
    () => (sessionId ? { sessionId } : { machineId: input.scope.machineId }),
    [sessionId, input.scope.machineId],
  );
  const { discard, discardDisabledReason, undo, undoAvailable, retireUndo } =
    hunkDiscard;
  return React.useMemo(
    () => ({
      source: { kind: 'live' as const, root: input.scope.rootPath },
      host,
      serverId: input.scope.serverId ?? null,
      ...(input.discard ? { onDiscard: discard, discardDisabledReason } : {}),
      ...(undoAvailable ? { undo } : {}),
      onReviewAction: retireUndo,
    }),
    [
      input.scope.rootPath,
      input.scope.serverId,
      host,
      input.discard,
      discard,
      discardDisabledReason,
      undoAvailable,
      undo,
      retireUndo,
    ],
  );
}
