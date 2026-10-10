import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import * as React from 'react';

import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionListOrganizationServerIds } from '@/sync/domains/session/organization/sessionListOrganizationServerIds';
import { storage } from '@/sync/domains/state/storage';
import { getSessionAvatarId } from '@/utils/sessions/sessionUtils';

import { readBotActivity, type BotActivity } from './botActivity';

/** How many faces the closed Bots entries show before the roster opens (lab `b-rail Ap`). */
const SUMMARY_FACE_COUNT = 3;

type SessionListRowsByServerId = Readonly<
  Record<
    string,
    Readonly<Record<string, SessionListRenderableSession>> | undefined
  >
>;

/** What a closed Bots entry says: the loaded Bots that need you, and a few faces, needs-you first. */
export type BotsSummary = Readonly<{
  needsYou: number;
  faces: readonly Readonly<{ key: string; avatarId: string }>[];
}>;

const EMPTY_SUMMARY: BotsSummary = { needsYou: 0, faces: [] };

const ACTIVITY_ORDER: Readonly<Record<BotActivity, number>> = {
  needsYou: 0,
  working: 1,
  quiet: 2,
};

/** The Homes whose Bots the closed entries read: the same Homes the Sessions list presents. */
export function useBotsHomeServerIds(): readonly string[] {
  const selection = useSessionListSelectionState();
  return React.useMemo(
    () =>
      resolveSessionListOrganizationServerIds({
        allowedServerIds: selection.allowedServerIds,
        activeServerId: selection.activeServerId,
      }),
    [selection.activeServerId, selection.allowedServerIds],
  );
}

function sameSummary(a: BotsSummary, b: BotsSummary): boolean {
  return (
    a.needsYou === b.needsYou &&
    a.faces.length === b.faces.length &&
    a.faces.every(
      (face, index) =>
        face.key === b.faces[index]?.key &&
        face.avatarId === b.faces[index]?.avatarId,
    )
  );
}

/**
 * The one summary of loaded Bots for always-mounted entries (the rail's Bots badge, the phone's Bots row
 * in My work). The store notifies on every change anywhere, so the rows are walked only when one of these
 * Homes replaced its row map; every other notification, and an unchanged result, returns the previous
 * summary object. Activity comes from the roster's own classifier.
 */
export function createBotsSummaryReader(
  serverIds: readonly string[],
): (rowsByServerId: SessionListRowsByServerId) => BotsSummary {
  let readRows: ReadonlyArray<SessionListRowsByServerId[string]> | null = null;
  let summary = EMPTY_SUMMARY;
  return (rowsByServerId) => {
    const rows = serverIds.map((serverId) => rowsByServerId[serverId]);
    if (
      readRows !== null &&
      rows.every((homeRows, index) => homeRows === readRows![index])
    )
      return summary;
    readRows = rows;
    const now = Date.now();
    const bots: Array<
      Readonly<{
        key: string;
        avatarId: string;
        rank: number;
        activeAt: number;
      }>
    > = [];
    let needsYou = 0;
    rows.forEach((homeRows, index) => {
      if (!homeRows) return;
      const serverId = serverIds[index]!;
      for (const row of Object.values(homeRows)) {
        if (readSessionBotV1(row.metadata?.bot)?.kind !== 'bot') continue;
        const activity = readBotActivity(row, now);
        if (activity === 'needsYou') needsYou += 1;
        bots.push({
          key: `${serverId}\u0000${row.id}`,
          avatarId: getSessionAvatarId(row, serverId),
          rank: ACTIVITY_ORDER[activity],
          activeAt: row.activeAt,
        });
      }
    });
    bots.sort((a, b) => a.rank - b.rank || b.activeAt - a.activeAt);
    const next: BotsSummary = {
      needsYou,
      faces: bots
        .slice(0, SUMMARY_FACE_COUNT)
        .map(({ key, avatarId }) => ({ key, avatarId })),
    };
    if (!sameSummary(summary, next)) summary = next;
    return summary;
  };
}

/** The loaded-Bots summary, subscribed narrowly: unrelated store changes keep the same object. */
export function useBotsSummary(): BotsSummary {
  const serverIds = useBotsHomeServerIds();
  const read = React.useMemo(
    () => createBotsSummaryReader(serverIds),
    [serverIds],
  );
  return storage((state) => read(state.sessionListRowsByServerId));
}
