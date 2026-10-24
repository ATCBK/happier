import { posix, win32 } from 'node:path';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { expandHomeRelativePath, getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';

type SessionCheckoutPlacement = Readonly<{
  machineId?: unknown;
  path?: unknown;
  homeDir?: unknown;
  sessionWorkspaceLocationV1?: unknown;
}>;

/** Equality requires a known Machine and the same absolute physical checkout. */
export function hasSameSessionCheckout(current: SessionCheckoutPlacement, next: SessionCheckoutPlacement): boolean {
  const machineId = current.machineId;
  if (typeof machineId !== 'string' || !machineId.trim() || machineId !== next.machineId
    || typeof current.path !== 'string' || typeof next.path !== 'string') return false;
  const machinePath = (metadata: SessionCheckoutPlacement, path: string): string => {
    const workspace = resolveSessionWorkspaceRootForMachine({ metadata, machineId, candidatePath: path });
    return typeof metadata.homeDir === 'string'
      ? expandHomeRelativePath({ path: workspace.machinePath, homeDir: metadata.homeDir })
      : workspace.machinePath;
  };
  const currentPath = machinePath(current, current.path);
  const nextPath = machinePath(next, next.path);
  return (posix.isAbsolute(currentPath) || win32.isAbsolute(currentPath))
    && (posix.isAbsolute(nextPath) || win32.isAbsolute(nextPath))
    && getPathRemainderWithinBase(currentPath, nextPath) === '';
}
