import * as React from 'react';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useSettingActionWriter, type SettingActionAddress } from '@/components/settings/catalog/useSettingActionWriter';
import type { SettingValue } from '@/components/settings/catalog/settingDeclarations';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { Modal } from '@/modal';
import { t } from '@/text';

/** Presentation only: declared-setting admission and custody stay with the canonical writer. */
export function useSettingActionFeedback(options?: Parameters<typeof useSettingActionWriter>[0]) {
    const write = useSettingActionWriter(options);
    const setSetting = React.useCallback(async (setting: SettingActionAddress, value: SettingValue): Promise<boolean> => {
        try {
            const result = await write(setting, value);
            if (!write.isCurrent(setting)) return false;
            if (result.ok) return true;
            if (isActionApprovalDeclinedErrorCode(result.errorCode)) return false;
            if (presentActionTurnedOffNoticeIfOff(result, 'settings.set')) return false;
        } catch {
            if (!write.isCurrent(setting)) return false;
        }
        Modal.alert(t('common.error'), t('common.unavailable'));
        return false;
    }, [write]);
    return { setSetting, isCurrent: write.isCurrent };
}
