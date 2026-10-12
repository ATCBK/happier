import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';

import type { ModelCatalogRow, ModelCatalogRowState } from './buildModelCatalogRows';

/** Human-readable label for a row's derived lifecycle state. */
export function modelCatalogStateLabel(state: ModelCatalogRowState): string {
    switch (state) {
        case 'not_installed':
            return t('settingsVoice.local.models.state.notInstalled');
        case 'downloading':
            return t('settingsVoice.local.models.state.downloading');
        case 'installed':
            return t('settingsVoice.local.models.state.installed');
        case 'warming':
            return t('settingsVoice.local.models.state.warming');
        case 'ready':
            return t('settingsVoice.local.models.state.ready');
        case 'evicted':
            return t('settingsVoice.local.models.state.evicted');
        case 'error':
            return t('settingsVoice.local.models.state.error');
        case 'unknown':
            return t('settingsVoice.local.models.state.unknown');
        case 'unsupported':
            return t('settingsVoice.local.daemonInference.states.runtimeUnavailable');
        default:
            return t('settingsVoice.local.models.state.notInstalled');
    }
}

/**
 * Build the per-row detail string: the lifecycle state, plus download progress
 * while downloading, declared artifact bytes when the daemon reports them, and the last
 * error message on failure. Pure (modulo `t`), so it is unit-testable.
 */
export function formatModelCatalogRowDetail(row: ModelCatalogRow): string {
    const parts: string[] = [modelCatalogStateLabel(row.state)];
    if (row.state === 'downloading' && typeof row.progress === 'number') {
        parts.push(`${Math.round(row.progress * 100)}%`);
    }
    if (row.state === 'error' && row.lastError) {
        parts.push(row.lastError);
    }
    if (
        typeof row.loadedArtifactBytes === 'number'
        && (row.state === 'ready' || row.state === 'warming' || row.state === 'evicted')
    ) {
        parts.push(t('settingsVoice.local.models.modelFiles', { size: formatHappierDataBytes(row.loadedArtifactBytes, { kind: 'storage' }) }));
    }
    return parts.join(' • ');
}
