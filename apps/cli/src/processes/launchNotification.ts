import type { ChildProcess } from 'node:child_process';
import { z } from 'zod/mini';

export const PROCESS_LAUNCH_NOTIFICATION_PATH = '/processes/launch-notify';
export const ProcessLaunchNotificationRequestSchema = z.strictObject({});
export const ProcessLaunchNotificationResultSchema = z.strictObject({ accepted: z.literal(true) });

const listeners = new Set<() => void>();
const observedChildren = new WeakSet<Pick<ChildProcess, 'pid' | 'once'>>();

/** A launch invalidates discovery, never supplies process identity or ownership. */
export function invalidateProcessLaunchDiscovery(): void {
    for (const listener of listeners) listener();
}

export function subscribeProcessLaunchDiscovery(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Runners reach their daemon through its existing private authenticated control transport. */
export async function notifyProcessLaunch(): Promise<void> {
    try {
        const { daemonPost } = await import('@/daemon/controlHttp');
        ProcessLaunchNotificationResultSchema.safeParse(await daemonPost(PROCESS_LAUNCH_NOTIFICATION_PATH,
            ProcessLaunchNotificationRequestSchema.parse({})));
    } catch {
        // An absent/older daemon keeps the existing demanded full-census backstop.
    }
}

export function observeProcessLaunch(child: Pick<ChildProcess, 'pid' | 'once'>): void {
    if (observedChildren.has(child)) return;
    observedChildren.add(child);
    // A managed wrapper may be installed after its custody handshake, after the
    // spawn event. A native PID exists only after the OS accepted the spawn.
    if (typeof child.pid === 'number') void notifyProcessLaunch();
    else child.once('spawn', () => { void notifyProcessLaunch(); });
}
