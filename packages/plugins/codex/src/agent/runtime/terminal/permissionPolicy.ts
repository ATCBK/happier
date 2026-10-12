import { normalizeAcpPermissionIntent } from '@happier-dev/plugin-sdk/agents/runtime';

import type { CodexTerminalPermissionPolicy } from './invocation.js';

export type CodexTerminalPermissionMode =
  | 'default'
  | 'read-only'
  | 'safe-yolo'
  | 'yolo'
  | 'bypassPermissions'
  | 'acceptEdits'
  | 'plan';

export function resolveCodexTerminalPermissionPolicy(
  permissionMode: CodexTerminalPermissionMode | string,
  workspaceWrites?: 'allow' | 'deny',
  unlistedTools?: 'ask' | 'deny',
): CodexTerminalPermissionPolicy {
  if (workspaceWrites === 'deny' || unlistedTools === 'deny') return { approvalPolicy: 'never', sandbox: 'read-only' };
  switch (normalizeAcpPermissionIntent(permissionMode)) {
    case 'read-only':
      return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'safe-yolo':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'yolo':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'plan':
    case 'default':
    default:
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
  }
}
