import * as React from 'react';

import { useSessionSelector } from '@/sync/store/hooks';

type TurnLike = Readonly<{ turnId: string; startedAt: number }>;

/** A turn is named by its place in the Session's started order ("turn 4"), never by its raw id. */
export function resolveSessionTurnNumber(
  turns: readonly TurnLike[] | null | undefined,
  turnId: string | null | undefined,
): number | null {
  if (!turns || !turnId) return null;
  const ordered = [...turns].sort(
    (left, right) => left.startedAt - right.startedAt,
  );
  const index = ordered.findIndex((turn) => turn.turnId === turnId);
  return index < 0 ? null : index + 1;
}

export function useSessionTurnNumber(
  sessionId: string | null | undefined,
  serverId: string | null | undefined,
  turnId: string | null | undefined,
): number | null {
  const select = React.useCallback(
    (
      session: Readonly<{
        sessionTurns?: Readonly<{ turns: readonly TurnLike[] }> | null;
      }> | null,
    ) => resolveSessionTurnNumber(session?.sessionTurns?.turns, turnId),
    [turnId],
  );
  return useSessionSelector(sessionId ?? '', serverId, select);
}
