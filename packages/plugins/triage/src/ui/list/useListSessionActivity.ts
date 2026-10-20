import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePluginHostApi, useSessionStates } from '@happier-dev/plugin-ui';
import { isPluginError } from '@happier-dev/plugin-sdk';
import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { triageEntryRowKey } from '../../projection/listWindow.js';
import { readTriageSessionLinksPageV1 } from '../../sessions/readEntrySessionLinks.js';
import { useTriageDurableAccount } from '../durable/accountDurableState.js';
import type { TriageAgentStateV1 } from '../detail/agentState.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailResultV1Schema } from '../../actions/entryDetailProtocol.js';

type LinksByEntry = ReadonlyMap<string, readonly string[]>;
type LinkRead = Readonly<{ links: LinksByEntry; status: 'reading' | 'ready' | 'unavailable' }>;

const INITIAL: LinkRead = Object.freeze({ links: new Map(), status: 'reading' });

function selectAgentState(state: SessionStateV1): TriageAgentStateV1 {
  return {
    lifecycle: state.lifecycle,
    operational: state.operational,
    workStatus: { bucket: state.workStatus.bucket, tone: state.workStatus.tone },
    ...(state.agent === undefined ? {} : { agent: state.agent }),
  };
}

/**
 * One mounted list join: the existing Session-link index supplies relationships,
 * and the host's shared Session hook supplies current Work facts. Acquisition is
 * relation-addressed once for each entry in the window, never placed on each
 * row. Only those relations are paged; no Account corpus or durable mirror is made.
 */
export function useTriageListSessionActivityV1(input: Readonly<{
  entryRefs: readonly TriageEntryRefV1[];
  /** Moves once per list pass that read (`TriageListWindowSnapshotV1.passes`); each move re-reads the links once. */
  acquisition: unknown;
  active: boolean;
  /** Source-owned links read through the same detail relationship projection as the opened entry. */
  sourceOwnedEntries?: ReadonlyMap<string, string>;
}>): Readonly<{
  /** The live states of each listed entry's linked Sessions that have answered, by row key. */
  agentStates: ReadonlyMap<string, readonly TriageAgentStateV1[]>;
  /** Relationship truth survives unreadable or stopped Session activity. */
  linkedSessions: LinksByEntry;
  linksStatus: LinkRead['status'];
  incomplete: boolean;
  unavailable: boolean;
  retry(): void;
}> {
  const host = usePluginHostApi();
  const { collections } = useTriageDurableAccount();
  const keys = input.entryRefs.map(triageEntryRowKey).sort();
  const keysIdentity = JSON.stringify(keys);
  const [read, setRead] = useState<LinkRead>(INITIAL);
  const [demand, setDemand] = useState(0);

  useEffect(() => {
    if (!input.active) return;
    if (keys.length === 0) {
      setRead((previous) => (previous.status === 'ready' && previous.links.size === 0
        ? previous
        : { links: new Map(), status: 'ready' }));
      return;
    }
    if (collections === null && (input.sourceOwnedEntries?.size ?? 0) === 0) {
      setRead((previous) => (previous.status === 'unavailable' ? previous : { ...previous, status: 'unavailable' }));
      return;
    }
    const cancellation = new AbortController();
    const wanted = new Set(keys);
    const entries = new Map(input.entryRefs.map((entryRef) => [triageEntryRowKey(entryRef), entryRef]));
    // Links already read stay the answer while they are re-read (last known good); only a read that has not
    // answered yet, or one that failed, says it is reading.
    setRead((previous) => (previous.status === 'ready' || previous.status === 'reading'
      ? previous
      : { ...previous, status: 'reading' }));
    void (async () => {
      const links = new Map<string, string[]>();
      let retried = false;
      try {
        const results = await Promise.allSettled(Array.from(entries.values(), async (entryRef) => {
          const key = triageEntryRowKey(entryRef);
          const sourceInstanceId = input.sourceOwnedEntries?.get(key);
          if (sourceInstanceId !== undefined) {
            const result = TriageReadEntryDetailResultV1Schema.parse(await host.executeAction(
              TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, { v: 1, entryRef, sourceInstanceId }, { signal: cancellation.signal },
            ));
            if (result.kind !== 'read') throw new Error('triage:sessionLinks:sourceUnavailable');
            links.set(key, result.linkedSessions.map((session) => session.sessionId));
            return;
          }
          if (collections === null) throw new Error('triage:sessionLinks:accountUnavailable');
          const cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const readPage = () => readTriageSessionLinksPageV1(collections.sessionLinks, {
              relation: { entryRef },
              ...(cursor === undefined ? {} : { cursor }),
            }, { signal: cancellation.signal });
            const page = await readPage().catch((error: unknown) => {
              if (cancellation.signal.aborted) throw error;
              if (retried || !isPluginError(error) || !error.retryable) throw error;
              host.diagnostic({
                code: 'triage_session_links_read_failed', severity: 'warning',
                message: error instanceof Error ? error.message : 'Session links could not be read',
                details: { code: error.code, retryable: error.retryable },
              });
              retried = true;
              return readPage();
            });
            throwIfAborted(cancellation.signal);
            for (const link of page.links) {
              const key = triageEntryRowKey(link.entryRef);
              if (!wanted.has(key)) continue;
              const sessions = links.get(key) ?? [];
              if (!sessions.includes(link.sessionId)) sessions.push(link.sessionId);
              links.set(key, sessions);
            }
            cursor = page.nextCursor;
            // Continuations are opaque and scoped to this relation. A repeated
            // position cannot complete it; other relations may use the same token.
            if (cursor !== undefined && cursors.has(cursor)) throw new Error('triage:sessionLinks:nonProgress');
            if (cursor !== undefined) cursors.add(cursor);
          } while (cursor !== undefined);
        }));
        // Keep successful relations even when another read failed. Every
        // independent request settles before publishing one window answer.
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        throwIfAborted(cancellation.signal);
        setRead((previous) => (previous.status === 'ready' && sameLinks(previous.links, links)
          ? previous
          : { links, status: 'ready' }));
      } catch (error) {
        if (cancellation.signal.aborted) return;
        host.diagnostic({
          code: 'triage_session_links_read_unavailable', severity: 'warning',
          message: error instanceof Error ? error.message : 'Session links could not be read',
          ...(isPluginError(error) ? { details: { code: error.code, retryable: error.retryable } } : {}),
        });
        setRead((previous) => {
          // Failed enumeration makes no absence claim. Keep prior links and
          // the pages that did answer, with incompleteness visible to the reader.
          const retained = new Map(previous.links);
          for (const [key, sessions] of links) {
            retained.set(key, Array.from(new Set([...(retained.get(key) ?? []), ...sessions])));
          }
          return { links: retained, status: 'unavailable' };
        });
      }
    })();
    return () => cancellation.abort();
    // keysIdentity is the exact window membership; unrelated render/row facts
    // do not start another link read.
  }, [collections, demand, host, input.acquisition, input.active, input.sourceOwnedEntries, keysIdentity]);

  const sessionIds = useMemo(() => Array.from(new Set(
    keys.flatMap((key) => read.links.get(key) ?? []),
  )), [keysIdentity, read.links]);
  const { sessions, refresh: refreshSessions } = useSessionStates(sessionIds, { select: selectAgentState });
  const retry = useCallback(() => {
    setDemand((value) => value + 1);
    refreshSessions();
  }, [refreshSessions]);
  const previousAgentStates = useRef<ReadonlyMap<string, readonly TriageAgentStateV1[]>>(new Map());
  const agentStates = useMemo(() => {
    const previous = previousAgentStates.current;
    const byEntry = new Map<string, readonly TriageAgentStateV1[]>();
    for (const key of keys) {
      const states = (read.links.get(key) ?? []).flatMap((id) => {
        const state = sessions.get(id)?.state;
        return state == null ? [] : [state];
      });
      if (states.length > 0) {
        const retained = previous.get(key);
        byEntry.set(key, retained !== undefined && retained.length === states.length
          && states.every((state, index) => state === retained[index]) ? retained : states);
      }
    }
    if (byEntry.size === previous.size && Array.from(byEntry).every(([key, states]) => previous.get(key) === states)) return previous;
    previousAgentStates.current = byEntry;
    return byEntry;
  }, [keysIdentity, read.links, sessions]);
  // Failed enumeration cannot establish that any listed row has a link. Only
  // known linked Sessions can have unreadable activity; empty rows stay quiet.
  const incomplete = read.status === 'reading'
    || (read.status === 'unavailable' && sessionIds.length > 0)
    || sessionIds.some((id) => sessions.get(id)?.status !== 'ready');
  return useMemo(() => ({
    agentStates,
    linkedSessions: read.links,
    linksStatus: read.status,
    incomplete,
    unavailable: (read.status === 'unavailable' && sessionIds.length > 0)
      || sessionIds.some((id) => ['unavailable', 'unsupported'].includes(sessions.get(id)?.status ?? 'loading')),
    retry,
  }), [agentStates, incomplete, read.links, read.status, retry, sessionIds, sessions]);
}

function sameLinks(left: LinksByEntry, right: LinksByEntry): boolean {
  if (left.size !== right.size) return false;
  for (const [key, sessions] of right) {
    const previous = left.get(key);
    if (previous === undefined || previous.length !== sessions.length
      || previous.some((sessionId, index) => sessionId !== sessions[index])) return false;
  }
  return true;
}
