import { Modal } from '@/modal';
import { t } from '@/text';
import { waitForSystemTaskResult } from '@/components/systemTasks/createSystemTaskRunner';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { isSystemTaskBridgeUnavailableError } from '@/components/systemTasks/systemTaskStartError';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

/**
 * What removing a Home did to this computer (R15 c). `not_applicable`: this app has no local
 * background-service bridge (web, phones). `removed` / `no_service`: nothing of the desktop's serves
 * the Home any more. `user_owned`: a service the user installed serves it and was left alone.
 * `inventory_unavailable`: this computer's services could not be read, so nothing was changed.
 * `uninstall_failed`: the desktop's service for the Home could not be removed.
 * `canceled`: the task owner canceled the disconnect; keep the Home without asking again.
 */
export type ThisComputerHomeDisconnect =
    | Readonly<{ kind: 'not_applicable' | 'removed' | 'no_service' | 'canceled' }>
    | Readonly<{ kind: 'user_owned'; label: string | null }>
    | Readonly<{ kind: 'inventory_unavailable' | 'uninstall_failed'; message: string | null }>;

/**
 * The one step that disconnects this computer from a Home the app is forgetting, run before its
 * credentials and profile are removed: `daemon.service.relay.disconnect.v1` uninstalls the Home's
 * desktop-managed pinned service (never downloading a CLI to do it) and leaves a user's own service.
 */
export async function disconnectThisComputerFromHome(
    home: Readonly<{ serverUrl: string; serverIdentityId?: string | null }>,
    runner: SystemTaskRunner = getSystemTasksRunner(),
    context?: Readonly<{ signal?: AbortSignal }>,
): Promise<ThisComputerHomeDisconnect> {
    // Only the desktop's own bridge (and its deterministic dev bridge) runs local service tasks.
    if (runner.mode !== 'tauri' && runner.mode !== 'dev') return { kind: 'not_applicable' };
    let result;
    let taskId: string | undefined;
    try {
        throwIfAborted(context?.signal);
        taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.relay.disconnect.v1', {
            relayUrl: home.serverUrl,
            serverIdentityId: home.serverIdentityId ?? null,
        }));
        result = await waitForSystemTaskResult(runner, taskId, { signal: context?.signal });
        if (runner.getSnapshot(taskId)?.status === 'canceled') return { kind: 'canceled' };
    } catch (error) {
        if (context?.signal?.aborted) {
            if (taskId) await runner.cancel(taskId);
            throw error;
        }
        const message = error instanceof Error ? error.message : null;
        // No bridge to this computer's services: nothing was attempted. Any other failure may have
        // come after the uninstall started, so it blocks like a failed uninstall (never "Remove anyway").
        return isSystemTaskBridgeUnavailableError(error)
            ? { kind: 'inventory_unavailable', message }
            : { kind: 'uninstall_failed', message };
    }
    if (!result.ok) {
        const code = typeof result.error?.code === 'string' ? result.error.code : null;
        const message = typeof result.error?.message === 'string' ? result.error.message : null;
        // Only the producer's pre-uninstall inventory failure proves nothing was attempted.
        return code === 'service_inventory_unavailable'
            ? { kind: 'inventory_unavailable', message }
            : { kind: 'uninstall_failed', message };
    }
    const data = (result.data ?? {}) as { outcome?: unknown; label?: unknown };
    if (data.outcome === 'user_owned') {
        return { kind: 'user_owned', label: typeof data.label === 'string' ? data.label : null };
    }
    return { kind: data.outcome === 'removed' ? 'removed' : 'no_service' };
}

/**
 * The one decision every path that forgets a Home takes about this computer (Settings removal,
 * Personal Home erase): disconnect first, then say what happened. Returns whether forgetting the Home
 * may go ahead — `false` when the desktop's service could not be uninstalled, or when this computer's
 * services could not be read and the person declined to go ahead anyway.
 */
export async function disconnectThisComputerBeforeForgettingHome(
    home: Readonly<{ serverUrl: string; serverIdentityId?: string | null; label: string }>,
    runner?: SystemTaskRunner,
): Promise<boolean> {
    const disconnect = await disconnectThisComputerFromHome(home, runner);
    if (disconnect.kind === 'canceled') return false;
    if (disconnect.kind === 'uninstall_failed') {
        Modal.alert(
            t('machine.thisComputer.removal.uninstallFailedTitle'),
            t('machine.thisComputer.removal.uninstallFailedBody', { home: home.label }),
        );
        return false;
    }
    if (disconnect.kind === 'inventory_unavailable') {
        return await Modal.confirm(
            t('machine.thisComputer.removal.inventoryUnavailableTitle'),
            t('machine.thisComputer.removal.inventoryUnavailableBody', { home: home.label }),
            { confirmText: t('machine.thisComputer.removal.removeAnyway'), destructive: true },
        ) === true;
    }
    if (disconnect.kind === 'user_owned') {
        Modal.alert(
            t('machine.thisComputer.removal.userOwnedTitle'),
            t('machine.thisComputer.removal.userOwnedBody', { home: home.label, service: disconnect.label ?? home.label }),
        );
    }
    return true;
}
