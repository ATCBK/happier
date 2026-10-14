import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { Modal } from '@/modal';
import type { SessionReminderPresetV1 } from '@/sync/domains/session/organization/sessionReminderPreset';
import { t } from '@/text';

import {
    SessionReminderDateTimeModal,
    type SessionReminderDateTimeResult,
    type SessionReminderDateTimeSubmitResult,
} from './SessionReminderDateTimeModal';
import { SessionReminderPresetManagerModal } from './SessionReminderPresetManagerModal';

export async function showSessionReminderDateTimeModal(
    nowMs: number,
    onSubmit: (value: SessionReminderDateTimeResult) => Promise<SessionReminderDateTimeSubmitResult>,
    onSavePreset: (preset: SessionReminderPresetV1) => Promise<void>,
): Promise<SessionReminderDateTimeResult | null> {
    return await new Promise((resolve) => {
        Modal.show({
            component: SessionReminderDateTimeModal,
            props: { nowMs, onSubmit, onSavePreset, onResolve: resolve },
            onRequestClose: () => resolve(null),
            chrome: {
                kind: 'card',
                title: t('sessionsList.reminders.customTitle'),
                testID: 'session-reminder-date-time-modal',
                dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, maxHeightRatio: 0.86, size: 'md' },
            },
            closeOnBackdrop: true,
        });
    });
}

export async function showSessionReminderPresetManagerModal(
    presets: readonly SessionReminderPresetV1[],
    onSubmit: (value: SessionReminderPresetV1[]) => Promise<void>,
): Promise<SessionReminderPresetV1[] | null> {
    return await new Promise((resolve) => {
        Modal.show({
            component: SessionReminderPresetManagerModal,
            props: { presets, onSubmit, onResolve: resolve },
            onRequestClose: () => resolve(null),
            chrome: {
                kind: 'card',
                title: t('sessionsList.reminders.managePresets'),
                subtitle: t('sessionsList.reminders.managePresetsMessage'),
                testID: 'session-reminder-preset-manager-modal',
                dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.86, size: 'md' },
            },
            closeOnBackdrop: true,
        });
    });
}
