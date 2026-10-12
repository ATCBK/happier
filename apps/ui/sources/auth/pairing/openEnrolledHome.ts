import { Modal } from '@/modal';
import { focusExactHomeAndRefresh } from '@/sync/domains/server/focusExactHome';
import { t } from '@/text';
import { Platform } from 'react-native';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';

export type OpenEnrolledHomeResult = 'opened' | 'returned_to_shell' | 'cancelled';

/**
 * Opens one exact already-adopted Home through the canonical exact-Home focus
 * owner, which also refreshes auth when that Home was already focused (the
 * identity did not move but the committed credential did). A failed open cannot
 * undo the committed credential/profile, so keep that exact profile available
 * for retry and let the user return to the shell without claiming focus changed.
 */
export async function openEnrolledHomeOrReturnToShell(params: Readonly<{
    profileId: string;
    targetLabel: string;
    isCurrent: () => boolean;
    refreshAuth: () => Promise<void>;
}>): Promise<OpenEnrolledHomeResult> {
    while (params.isCurrent()) {
        const opened = await focusExactHomeAndRefresh({
            serverId: params.profileId,
            // Web keeps Home focus tab-scoped; native and desktop are device-scoped.
            scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
            refreshAuth: params.refreshAuth,
        });
        // Focusing the Home may retire the old Account/command authority itself.
        // Keep the focus owner's known ACK; callers still fence their mounted
        // interest before navigating. A failed or unknown open never becomes success.
        if (opened) return 'opened';
        if (!params.isCurrent()) return 'cancelled';

        let retry = false;
        await Modal.alertAsync(
            params.targetLabel,
            // The Home is committed; only the focus switch failed. The add_home
            // success copy would report that outcome as intended, so keep them apart.
            t('connect.homeSavedOpenFailedBody'),
            [
                {
                    text: t('common.open'),
                    onPress: () => {
                        retry = true;
                    },
                },
                { text: t('common.cancel'), style: 'cancel' },
            ],
        );
        if (!params.isCurrent()) return 'cancelled';
        if (!retry) {
            return 'returned_to_shell';
        }
    }
    return 'cancelled';
}
