import { randomUUID } from 'node:crypto';
import type { SpawnFailureV1 } from '@happier-dev/protocol/machines/processes/spawnFailureV1';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import type { TrackedSession } from '../types';
import type { ActivityLog } from './activityLog';

/** Observes admitted activation/start results; it never makes a resume or launch decision. */
export function createGuardSessionRestoration(input: Readonly<{
  activity: Pick<ActivityLog, 'list' | 'append' | 'markUndone'>;
  nowMs?: () => number;
}>) {
  const now = input.nowMs ?? Date.now;
  const readStopped = async (sessionId: string, attribution: RequesterWorkAttributionV1) => {
    const rows = await input.activity.list({ range: '30d', requester: attribution });
    const latest = rows.entries.find(row => row.kind === 'stopped_session' && row.outcome !== 'failed'
      && ['idle_sessions', 'memory_guard', 'ceiling'].includes(row.rule)
      && row.subject?.kind === 'session' && row.subject.sessionId === sessionId);
    return latest?.undoneAt === undefined ? latest : undefined;
  };
  return {
    async onSessionRunnerStarted(tracked: TrackedSession): Promise<void> {
      if (!tracked.happySessionId || !tracked.requesterWorkAttributionV1) return;
      const receipt = await readStopped(tracked.happySessionId, tracked.requesterWorkAttributionV1);
      if (receipt) await input.activity.markUndone({ id: randomUUID(), ref: receipt.id, at: now(), attribution: tracked.requesterWorkAttributionV1 });
    },
    async onActivationRejected(event: Readonly<{ sessionId: string; reason: string;
      attribution: RequesterWorkAttributionV1; failure?: SpawnFailureV1 }>): Promise<void> {
      const receipt = await readStopped(event.sessionId, event.attribution);
      if (!receipt) return;
      const failure = event.failure ?? { reason: 'other' as const };
      await input.activity.append({ v: 1, id: randomUUID(), at: now(), kind: 'start_failed', rule: receipt.rule,
        subject: receipt.subject, attribution: event.attribution, outcome: 'failed', ref: receipt.id,
        note: `Could not resume: ${event.reason}`, failure,
        nextStep: failure.reason === 'no_ptys' ? 'close_idle_terminals' : 'review_processes',
        ...(receipt.wayBack ? { wayBack: receipt.wayBack } : {}) });
    },
  };
}
