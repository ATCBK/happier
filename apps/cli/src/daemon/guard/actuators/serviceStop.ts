import type { GuardCandidate } from '../guardPlanner';

/** The incumbent managed-service owner owns stop intent and listener recovery. */
export async function serviceStop(candidate: GuardCandidate, signal: AbortSignal): Promise<
  Readonly<{ status: 'stopped' } | { status: 'failed'; reason: string }>> {
  if (signal.aborted) return { status: 'failed', reason: 'cancelled' };
  if (candidate.kind !== 'service' || candidate.target.kind !== 'service' || candidate.target.scope !== 'project'
    || candidate.root.owner.kind !== 'service'
    || !candidate.root.live || !candidate.root.stop) return { status: 'failed', reason: 'unsupported_target' };
  try { await candidate.root.stop(); return { status: 'stopped' }; }
  catch { return { status: 'failed', reason: 'native_stop_failed' }; }
}
