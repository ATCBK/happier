import { describe, expect, it } from 'vitest';

import { HAPPIER_COLLECTION_LIST_METRICS, HAPPIER_COLLECTION_RAIL_WIDTH_PX } from '@happier-dev/plugin-ui/presentation';
import { SESSION_LIST_ROW_IDENTITY_METRICS, SESSION_LIST_ROW_WIDTH_METRICS, resolveSessionListRowTitleTextMetrics } from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { resolveSidebarDockMaxWidthPx, SIDEBAR_DOCK_MIN_WIDTH_PX } from './sidebarSizing';

describe('sidebar content minimum', () => {
    it('keeps a sixteen-character session title beside identity and compact trailing controls at every density', () => {
        for (const density of ['default', 'compact', 'minimal'] as const) {
            const metrics = SESSION_LIST_ROW_WIDTH_METRICS;
            const titlePx = metrics.titleMinCharacters * resolveSessionListRowTitleTextMetrics({ density, readableNativePhoneMinimal: false }).fontSize / 2;
            const demand = 2 * HAPPIER_COLLECTION_LIST_METRICS.rowInset + 2 * metrics.borderPx + 2 * metrics[density].paddingPx
                + SESSION_LIST_ROW_IDENTITY_METRICS[density].slotSize + metrics[density].contentMarginPx + titlePx + metrics.trailingMarginPx + metrics.trailingMinPx;
            expect(SIDEBAR_DOCK_MIN_WIDTH_PX).toBeGreaterThanOrEqual(demand);
        }
        expect(SIDEBAR_DOCK_MIN_WIDTH_PX).toBeLessThanOrEqual(HAPPIER_COLLECTION_RAIL_WIDTH_PX.standard);
    });
});

describe('resolveSidebarDockMaxWidthPx', () => {
    it('falls back to a safe max width when windowWidthPx is invalid', () => {
        expect(resolveSidebarDockMaxWidthPx(NaN)).toBeGreaterThanOrEqual(480);
        expect(resolveSidebarDockMaxWidthPx(0)).toBeGreaterThanOrEqual(480);
        expect(resolveSidebarDockMaxWidthPx(-10)).toBeGreaterThanOrEqual(480);
    });

    it('scales up max width on larger windows with a cap', () => {
        expect(resolveSidebarDockMaxWidthPx(800)).toBe(480);
        expect(resolveSidebarDockMaxWidthPx(1200)).toBe(600);
        expect(resolveSidebarDockMaxWidthPx(2000)).toBe(720);
    });
});
