import * as React from 'react';
import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import type { SettingValue } from '@/components/settings/catalog/settingDeclarations';
import { Modal } from '@/modal';
import { t } from '@/text';
import { AGENT_SETTINGS } from './agentsSettings';

/** Thin UI adapter; Action admission, approval and keyed mutation remain canonical. */
export function useAgentPreferenceWriter() {
    const write = useSettingActionWriter();
    return React.useCallback(async (setting: 'defaultPermission' | 'enabled' | 'executableSource', agentTargetKey: string, value: SettingValue) => {
        try {
            const result = await write(AGENT_SETTINGS.settings[setting], { agentTargetKey, value });
            if (!result.ok) await Modal.alert(t('common.error'), t('common.unavailable'));
        } catch { await Modal.alert(t('common.error'), t('common.unavailable')); }
    }, [write]);
}
