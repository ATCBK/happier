import type { WorkspaceActionId } from '@happier-dev/protocol';
import { workspaceActionFailure, type WorkspaceActionOutcome } from './workspaceActions';

type MountedWorkspaceAction = (request: Readonly<{ actionId: WorkspaceActionId; input: unknown; signal?: AbortSignal }>) => Promise<WorkspaceActionOutcome>;
let mounted: MountedWorkspaceAction | null = null;

/** One client/window has one WorkspaceProvider. Cleanup cannot retire a newer mount. */
export function registerMountedWorkspaceAction(execute: MountedWorkspaceAction): () => void {
    mounted = execute;
    return () => { if (mounted === execute) mounted = null; };
}

export function captureMountedWorkspaceAction(): MountedWorkspaceAction | null {
    return mounted;
}

/** A mounted workspace owns navigation; only an absent mount uses the native router. */
export async function openWorkspaceHrefOrElse(href: string, fallback: () => void): Promise<void> {
    const execute = captureMountedWorkspaceAction();
    if (!execute) { fallback(); return; }
    const result = await execute({ actionId: 'workspace.tabs.open', input: { href } });
    if (!result.ok) throw new Error(result.errorCode);
}

export async function invokeWorkspaceAction(request: Parameters<MountedWorkspaceAction>[0]): Promise<WorkspaceActionOutcome> {
    return mounted ? await mounted(request) : workspaceActionFailure('unsupported_action');
}
