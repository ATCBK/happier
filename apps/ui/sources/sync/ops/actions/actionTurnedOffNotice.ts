import { router } from 'expo-router';
import { isActionTurnedOffErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * An Action the person turned off in Settings, Actions did not fail. This is the one in-app
 * presentation: a calm notice that names the cause and leads to that Action's setting.
 */
export function presentActionTurnedOffNotice(actionId: string): void {
    Modal.alert(t('actionConfirmations.turnedOffTitle'), t('actionConfirmations.turnedOffMessage'), [
        { text: t('common.ok'), style: 'cancel' },
        { text: t('actionConfirmations.openActionSettings'), onPress: () => router.push(`/settings/actions/${encodeURIComponent(actionId)}`) },
    ]);
}

/** Presents the Off notice when the result is exactly that; the caller keeps its own failure path otherwise. */
export function presentActionTurnedOffNoticeIfOff(result: Readonly<{ errorCode?: unknown }>, actionId: string): boolean {
    if (!isActionTurnedOffErrorCode(result.errorCode)) return false;
    presentActionTurnedOffNotice(actionId);
    return true;
}
