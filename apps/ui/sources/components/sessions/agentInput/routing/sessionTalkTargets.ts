import * as React from 'react';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { useShallow } from 'zustand/react/shallow';

import { selectSessionRelationRecords } from '@/components/sessions/work/reportSubtree';
import { getStorage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRowStateByServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { getSessionName } from '@/utils/sessions/sessionUtils';

/** The `manager` relations the composer can address, named as this device holds them. */
export type SessionTalkTargets = Readonly<{
  manager: string | null;
  workers: readonly string[];
  siblings: readonly string[];
}>;

/**
 * A preview of whom `manager`, `workers` and `siblings` resolve to now, from the loaded `manager`
 * relation (the same records Work and the breadcrumb read). The Action still resolves the selector at
 * admission; this only names the sessions before the person picks one.
 */
export function readSessionTalkTargets(
  sessions: Readonly<Record<string, Session>>,
  sessionId: string,
  serverId: string | null,
  rowsByServerId?: SessionListRowStateByServerId,
): SessionTalkTargets {
  const records = selectSessionRelationRecords(
    sessions,
    serverId,
    rowsByServerId,
  );
  const managerId = readSessionManagerSessionIdV1(records[sessionId]) ?? null;
  const workers: Session[] = [];
  const siblings: Session[] = [];
  for (const session of Object.values(records)) {
    if (session.id === sessionId) continue;
    const lead = readSessionManagerSessionIdV1(session);
    if (!lead) continue;
    if (lead === sessionId) workers.push(session);
    else if (managerId && lead === managerId) siblings.push(session);
  }
  // Oldest first, the order the lead started them in (Work's report order).
  const names = (list: Session[]) =>
    list
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((session) => getSessionName(session));
  const manager = managerId ? records[managerId] : undefined;
  return {
    manager: manager ? getSessionName(manager) : null,
    workers: names(workers),
    siblings: names(siblings),
  };
}

/** Mounted only while the picker is open; a flat string list keeps unrelated store updates quiet. */
export function useSessionTalkTargets(
  sessionId: string,
  serverId: string | null,
): SessionTalkTargets {
  const flat = getStorage()(
    useShallow((state) => {
      const targets = readSessionTalkTargets(
        state.sessions,
        sessionId,
        serverId,
        state.sessionListRowsByServerId,
      );
      return [
        targets.manager ?? '',
        String(targets.workers.length),
        ...targets.workers,
        ...targets.siblings,
      ];
    }),
  );
  return React.useMemo(() => {
    const workerCount = Number(flat[1]);
    return {
      manager: flat[0] || null,
      workers: flat.slice(2, 2 + workerCount),
      siblings: flat.slice(2 + workerCount),
    };
  }, [flat]);
}
