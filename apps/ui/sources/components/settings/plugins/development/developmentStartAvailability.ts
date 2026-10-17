import type { PluginReadOnlySnapshotNoticeState } from '../model/pluginMarketplaceModel';

/**
 * Why the three ways to start (Create, Create with Agent, Develop a local plugin) can't be used, said
 * once above them: the chosen machine has not answered its current read yet, or it answered without
 * offering development. No machine chosen, a disconnected or a failed read already has its own message
 * on the page, so the tiles stay quiet then (one message per state).
 */
export type DevelopmentStartUnavailableReason =
  | 'waitingForMachine'
  | 'notOffered';

export function resolveDevelopmentStartUnavailableReason(
  input: Readonly<{
    noTarget: boolean;
    notice: PluginReadOnlySnapshotNoticeState | null;
    daemonOperationsAvailable: boolean;
    createAvailable: boolean;
    sourceInstallAvailable: boolean;
  }>,
): DevelopmentStartUnavailableReason | null {
  if (input.noTarget) return null;
  if (!input.daemonOperationsAvailable) {
    return input.notice === null || input.notice.reason === 'refreshing'
      ? 'waitingForMachine'
      : null;
  }
  return input.createAvailable || input.sourceInstallAvailable
    ? null
    : 'notOffered';
}
