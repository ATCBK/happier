import { isHappierToolAutoApprovedByAgentLayerV1 } from '@happier-dev/protocol/tools/happierToolAutoApprovalV1';

import { isDefaultWriteLikeToolName } from './writeLikeToolNameHeuristics';

export const SHARED_PERMISSION_SAFE_TOOL_NAME_TOKENS = [
  'save_memory',
  'think',
] as const;

const SHARED_PERMISSION_SAFE_TOOL_NAMES = new Set([
  'think',
  'save_memory',
  'mcp__happier__think',
  'mcp__happier__save_memory',
  'mcp__happy__think',
  'mcp__happy__save_memory',
  'happier__think',
  'happier__save_memory',
  'happy__think',
  'happy__save_memory',
  'happier_think',
  'happier_save_memory',
  'happy_think',
  'happy_save_memory',
]);

export const SHARED_PERMISSION_GUARD_TOOL_NAMES = [
  'external_directory',
  'doom_loop',
] as const;

function normalizePermissionToolName(toolName: string): string {
  return String(toolName ?? '').trim().toLowerCase();
}

export const SHARED_PROVIDER_ENFORCED_SAFE_TOOL_NAME_SEGMENTS = [
  ...SHARED_PERMISSION_SAFE_TOOL_NAME_TOKENS,
  // ACP fs bridge operations are host-side capability calls. Reads and writes outside Read Only/Plan
  // remain auto-approved to avoid duplicating provider permission policy at the host layer.
  'readtextfile',
  'writetextfile',
  'read_text_file',
  'write_text_file',
] as const;

export function isSharedPermissionSafeToolName(toolName: string): boolean {
  const normalized = normalizePermissionToolName(toolName);
  if (!normalized) return false;
  if (isHappierToolAutoApprovedByAgentLayerV1(normalized)) return true;
  return SHARED_PERMISSION_SAFE_TOOL_NAMES.has(normalized);
}

export function isSharedHappierShellBridgeToolName(toolName: string): boolean {
  const normalized = normalizePermissionToolName(toolName);
  if (!normalized) return false;
  return isSharedPermissionSafeToolName(normalized);
}

export function isPermissionGuardToolName(toolName: string): boolean {
  const normalized = normalizePermissionToolName(toolName);
  if (!normalized) return false;
  return SHARED_PERMISSION_GUARD_TOOL_NAMES.includes(normalized as typeof SHARED_PERMISSION_GUARD_TOOL_NAMES[number]);
}

export function isSharedPermissionWriteLikeToolName(toolName: string): boolean {
  const normalized = normalizePermissionToolName(toolName);
  if (!normalized) return true;
  return isDefaultWriteLikeToolName(normalized);
}
