import type { ManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import {
  collectRetainedSessionInventoryVisibility,
  fetchSessionInventoryPage,
  type SessionInventoryVisibilityPageFetcher,
} from './sessionInventoryVisibility';
import type { StopSessionResult } from './stopSessionContract';
import { logger } from '@/ui/logger';

type Unsubscribe = () => void;
type Subscribe<T> = (listener: (change: T) => void | Promise<void>) => Unsubscribe;

type CreationSessionLookup = (args: Readonly<{
  token: string;
  tags: readonly string[];
}>) => Promise<
  | Readonly<{ state: 'available'; sessions: readonly Readonly<{ id: string }>[] }>
  | Readonly<{ state: 'unavailable' }>
>;

type ManagedSessionDirectoryRemovalParams = Readonly<{
  directories: Pick<ManagedSessionDirectories,
    'listRecords' | 'bind' | 'removeForSession' | 'removeUnboundCreation' | 'retryPendingRemovals'>;
  token: string;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  onSessionDeletedChange: Subscribe<Readonly<{ sessionId: string }>>;
  onSessionAccessReset: Subscribe<Readonly<{ cursor: number }>>;
  onConnectionStateChange: Subscribe<Pick<ManagedConnectionState, 'phase'>>;
  fetchInventoryPage?: SessionInventoryVisibilityPageFetcher;
  lookupCreationSessions?: CreationSessionLookup;
}>;

export async function subscribeManagedSessionDirectoryRemoval(
  params: ManagedSessionDirectoryRemovalParams,
): Promise<Unsubscribe> {
  const fetchInventoryPage = params.fetchInventoryPage
    ?? (async (args) => await fetchSessionInventoryPage({ ...args, token: params.token }));
  const lookupCreationSessions: CreationSessionLookup = params.lookupCreationSessions
    ?? (async (args) => {
      const { lookupSessionsByTags } = await import('@/session/transport/http/sessionsHttp');
      return await lookupSessionsByTags(args);
    });

  const reconcile = async (): Promise<void> => {
    let sessionIds: string[];
    let visible: ReadonlySet<string>;
    try {
      const records = await params.directories.listRecords();
      sessionIds = [...new Set(records.flatMap((record) => record.sessionId ? [record.sessionId] : []))];
      visible = await collectRetainedSessionInventoryVisibility({
        retainedSessionIds: sessionIds,
        scopes: ['active', 'archived'],
        fetchInventoryPage,
      });
    } catch (error) {
      // Retain unknown allocations and let Account recovery continue. Bootstrap
      // and the next healthy connection retry through this same inventory owner.
      logger.warn('[MANAGED SESSION DIRECTORY] Inventory reconciliation pending', { error });
      return;
    }
    // No removal begins until every still-undecided Session has been checked.
    for (const sessionId of sessionIds) {
      if (!visible.has(sessionId)) {
        await params.directories.removeForSession({ sessionId, stopSession: params.stopSession });
      }
    }
  };

  const unsubscribes = [
    params.onSessionDeletedChange(async ({ sessionId }) => {
      // Home inactivity is not physical death: an automatic successor can still
      // own this Session, including one with an ordinary (unmanaged) directory.
      // Stop fences pending launches as well as retiring every tracked runner.
      // Keep failed cleanup inside the deletion cursor's existing replay custody.
      const stopped = await params.stopSession(sessionId);
      if (stopped.status !== 'stopped' && stopped.status !== 'not_found') {
        throw new Error('deleted_session_runner_retirement_incomplete');
      }
      await params.directories.removeForSession({ sessionId, stopSession: async () => stopped });
    }),
    params.onSessionAccessReset(reconcile),
  ];
  const dispose = (): void => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };

  try {
    // Bootstrap runs this before the Account-change carrier connects and before
    // this daemon admits fresh spawns. Handoff abort retains its own custody.
    for (const record of await params.directories.listRecords()) {
      if (record.pendingRemoval || record.origin !== 'creation' || record.sessionId !== null || record.sessionCreationTag === null) continue;
      try {
        const lookup = await lookupCreationSessions({ token: params.token, tags: [record.sessionCreationTag] });
        if (lookup.state === 'unavailable') throw new Error('managed_session_creation_lookup_unavailable');
        if (lookup.sessions.length > 1) throw new Error('managed_session_creation_lookup_ambiguous');
        const session = lookup.sessions[0];
        if (session) {
          await params.directories.bind({ allocationId: record.allocationId, sessionId: session.id });
        } else {
          await params.directories.removeUnboundCreation({ allocationId: record.allocationId });
        }
      } catch (error) {
        logger.warn('[MANAGED SESSION DIRECTORY] Startup reconciliation pending', { allocationId: record.allocationId, error });
      }
    }
    await params.directories.retryPendingRemovals({ stopSession: params.stopSession });
  } catch (error) {
    logger.warn('[MANAGED SESSION DIRECTORY] Startup cleanup unavailable', { error });
  }
  // A missed deletion can leave a bound allocation without pendingRemoval.
  // Compare retained ownership to the complete inventory at each existing wake.
  await reconcile();
  unsubscribes.push(params.onConnectionStateChange(async (state) => {
    if (state.phase === 'online') await reconcile();
  }));
  return dispose;
}
