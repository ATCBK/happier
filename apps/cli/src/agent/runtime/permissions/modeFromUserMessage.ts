import type { PermissionMode } from '@/api/types';

import { normalizePermissionModeToIntent } from './modeCanonical';

export function resolvePermissionModeForQueueingUserMessage(opts: {
  currentPermissionMode: PermissionMode | undefined;
  messagePermissionModeRaw: unknown;
}): { currentPermissionMode: PermissionMode | undefined; queuePermissionMode: PermissionMode; didChange: boolean } {
  const baseline = normalizePermissionModeToIntent(opts.currentPermissionMode) ?? opts.currentPermissionMode;
  // Send carries turn intent. Only the immediate mode Action changes the
  // Session baseline; steering still compares canonical effective modes.
  const queuePermissionMode = normalizePermissionModeToIntent(opts.messagePermissionModeRaw) ?? baseline ?? 'default';
  return {
    currentPermissionMode: baseline,
    queuePermissionMode,
    didChange: queuePermissionMode !== (baseline ?? 'default'),
  };
}
