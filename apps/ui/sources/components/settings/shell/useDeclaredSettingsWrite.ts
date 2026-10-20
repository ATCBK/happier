import * as React from 'react';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { SettingRef, SettingValue } from '@/components/settings/catalog/settingDeclarations';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { Modal } from '@/modal';
import { t } from '@/text';

export type DeclaredSettingsWrite = (setting: Pick<SettingRef, 'anchor'>, value: SettingValue) => Promise<boolean>;

/** Mounted settings authors share Action admission; declaration owners retain normalization and storage. */
export function useDeclaredSettingsWrite(execution: Pick<ReturnType<typeof useMountedActionExecution>, 'execute' | 'isCurrent'>): DeclaredSettingsWrite {
    const { execute, isCurrent } = execution;
    return React.useCallback(async (setting, value) => {
        try {
            const result = await execute('settings.set', { anchor: setting.anchor, value });
            if (!isCurrent()) return false;
            if (!result.ok) {
                if (result.errorCode === 'action_account_scope_changed' || isActionApprovalDeclinedErrorCode(result.errorCode)) return false;
                if (presentActionTurnedOffNoticeIfOff(result, 'settings.set')) return false;
                throw new Error(result.error);
            }
            SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(result.result);
            return true;
        } catch (error) {
            if (isCurrent()) Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
            return false;
        }
    }, [execute, isCurrent]);
}
