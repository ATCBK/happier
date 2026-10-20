import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_COLLECTION_RAIL_WIDTH_PX } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import {
    SESSION_LIST_ROW_IDENTITY_METRICS,
    SESSION_LIST_ROW_WIDTH_METRICS,
    resolveSessionListRowTitleTextMetrics,
} from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { BUILTIN_COLUMN_MINIMUM_WIDTH_PX } from './appRail/appShellColumnSizing';

export const SIDEBAR_DEFAULT_WIDTH_PX = HAPPIER_COLLECTION_RAIL_WIDTH_PX.standard;

const sessionRowDemands = (['default', 'compact', 'minimal'] as const).map(density => {
    const metrics = SESSION_LIST_ROW_WIDTH_METRICS;
    const title = resolveSessionListRowTitleTextMetrics({ density, readableNativePhoneMinimal: false });
    return 2 * HAPPIER_COLLECTION_LIST_METRICS.rowInset + 2 * metrics.borderPx + 2 * metrics[density].paddingPx
        + SESSION_LIST_ROW_IDENTITY_METRICS[density].slotSize + metrics[density].contentMarginPx
        + metrics.titleMinCharacters * title.fontSize / 2 + metrics.trailingMarginPx + metrics.trailingMinPx;
});

export const SIDEBAR_DOCK_MIN_WIDTH_PX = Math.ceil(Math.max(...sessionRowDemands, ...Object.values(BUILTIN_COLUMN_MINIMUM_WIDTH_PX)));

const SIDEBAR_BASE_MAX_PX = 480;
const SIDEBAR_MAX_PX_CAP = 720;
const SIDEBAR_MAX_PCT = 0.5;

export function resolveSidebarDockMaxWidthPx(windowWidthPx: number): number {
    if (!Number.isFinite(windowWidthPx) || windowWidthPx <= 0) return SIDEBAR_BASE_MAX_PX;
    const pctMax = Math.floor(windowWidthPx * SIDEBAR_MAX_PCT);
    return Math.max(SIDEBAR_BASE_MAX_PX, Math.min(SIDEBAR_MAX_PX_CAP, pctMax));
}
