import type { Metadata, PermissionMode } from '@/api/types';
import { resolvePermissionIntentFromMetadataSnapshot } from './modeFromMetadata';

export async function resolveStartupPermissionModeFromSession(opts: {
  /**
   * Lifecycle context retained by callers; every lifecycle uses the same
   * owner baseline. Transcript modes describe individual turns.
   */
  sessionKind?: 'fresh' | 'attach' | 'resume';
  session: {
    getMetadataSnapshot: () => Metadata | null;
    fetchLatestUserPermissionIntentFromTranscript: (opts?: { take?: number }) => Promise<{ intent: PermissionMode; updatedAt: number } | null>;
  };
  take?: number;
}): Promise<{ mode: PermissionMode; updatedAt: number } | null> {
  const resolved = resolvePermissionIntentFromMetadataSnapshot({ metadata: opts.session.getMetadataSnapshot() });
  return resolved ? { mode: resolved.intent, updatedAt: resolved.updatedAt } : null;
}
