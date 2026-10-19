import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { deriveSessionRuntimePresentationStateForSession } from '@/utils/sessions/sessionUtils';

/**
 * Restarting a session runner ends its provider process, which also stops every background agent
 * or shell it hosts. The daemon cannot see that work, so the user decides here before the restart
 * request is sent; the daemon trusts this confirmation for UI-originated restarts.
 * Resolves `true` when the restart may proceed.
 */
export async function confirmRunnerRestartStopsBackgroundWork(sessionId: string): Promise<boolean> {
    const session = storage.getState().sessions[sessionId];
    if (!session) return true;
    const runtime = deriveSessionRuntimePresentationStateForSession(session, Date.now());
    if (!runtime.backgroundActive) return true;
    return await Modal.confirm(
        t('session.runnerRestartBackgroundWork.title'),
        t('session.runnerRestartBackgroundWork.body', { count: runtime.backgroundActiveCount }),
        {
            cancelText: t('common.cancel'),
            confirmText: t('session.runnerRestartBackgroundWork.confirmAction'),
            destructive: true,
        },
    );
}
