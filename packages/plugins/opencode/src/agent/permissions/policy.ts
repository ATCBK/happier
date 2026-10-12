import {
  resolveAcpToolPermissionPolicy,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { listHappierToolAutoApprovedNamesV1 } from '@happier-dev/protocol/tools/happierToolAutoApprovalV1';

export type OpenCodePermissionValue =
  ReturnType<typeof resolveAcpToolPermissionPolicy>[string];

export function resolveOpenCodePermissionConfig(
  permissionMode: string | null | undefined,
): Readonly<Record<string, OpenCodePermissionValue>> {
  return resolveAcpToolPermissionPolicy(permissionMode);
}

export function buildOpenCodeSessionPermissionRuleset(
  permissionMode: string | null | undefined,
): ReadonlyArray<Readonly<{ permission: string; pattern: string; action: OpenCodePermissionValue }>> {
  return Object.entries(resolveOpenCodePermissionConfig(permissionMode)).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }));
}

export function buildOpenCodeSessionScopedPermissionRuleset(
  permissionMode: string | null | undefined,
  projection: Readonly<{
    registrations: readonly Readonly<{ projectedName: string }>[];
    requiredHappierServerName: string | null;
  }>,
): ReadonlyArray<Readonly<{ permission: string; pattern: string; action: OpenCodePermissionValue }>> {
  const baseRules = buildOpenCodeSessionPermissionRuleset(permissionMode);
  const ownAction = resolveOpenCodePermissionConfig(permissionMode)['*'];
  const alias = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return Object.freeze([
    ...baseRules,
    { permission: 'happier-session-*', pattern: '*', action: 'deny' as const },
    ...projection.registrations.map(({ projectedName }) => ({
      permission: `${alias(projectedName)}_*`, pattern: '*', action: ownAction,
    })),
    ...(projection.requiredHappierServerName
      ? listHappierToolAutoApprovedNamesV1().map((suffix) => ({
          permission: `${alias(projection.requiredHappierServerName!)}_${suffix}`,
          pattern: '*',
          action: 'allow' as const,
        }))
      : []),
  ]);
}

export function buildOpenCodePermissionEnv(
  permissionMode: string | null | undefined,
): Readonly<Record<string, string>> {
  return {
    OPENCODE_PERMISSION: JSON.stringify(resolveOpenCodePermissionConfig(permissionMode)),
  };
}
