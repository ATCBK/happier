import type { ActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { PermissionMode } from '@/api/types';

const PLAN_REVERSIBLE_SESSION_ACTION_IDS: ReadonlySet<string> = new Set([
  'session.mode.set',
  'session.goal.set',
  'session.goal.clear',
]);

/** Action effects enforce the ceiling; ordinary confirmation stays with the Action executor. */
export function resolveHappierActionPermission(params: Readonly<{
  spec: Pick<ActionSpec, 'id' | 'sideEffectClass'>;
  permissionMode: PermissionMode;
}>): 'approved' | 'denied' {
  const planModeSelfControl = params.permissionMode === 'plan'
    && PLAN_REVERSIBLE_SESSION_ACTION_IDS.has(params.spec.id);
  return (params.permissionMode === 'read-only' || params.permissionMode === 'plan')
    && !planModeSelfControl
    && params.spec.sideEffectClass !== 'none'
    && params.spec.sideEffectClass !== 'read'
    ? 'denied' : 'approved';
}
