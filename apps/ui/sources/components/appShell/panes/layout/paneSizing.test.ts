import { describe, expect, it } from 'vitest';
import { PANE_SIZING_DEFAULTS, resolveDockedPaneSizing } from './paneSizing';

describe('resolveDockedPaneSizing', () => {
    it('clamps the side pane before shrinking the stored session preference', () => {
        expect(resolveDockedPaneSizing({ arrangement: 'editor', containerWidthPx: 1180, mainMinPx: 480,
            rightMinPx: 260, detailsMinPx: 480, rightWidthPx: 340, detailsWidthPx: 520, sessionWidthPx: 440,
            mainDocked: true, rightGlobalMinPx: 260, rightGlobalMaxPx: Infinity, detailsGlobalMinPx: 480,
            detailsGlobalMaxPx: Infinity, rightDocked: true, detailsDocked: true,
        })).toMatchObject({ mainWidthPx: 440, rightWidthPx: 260, detailsWidthPx: 480 });
    });
    it('reserves stored session and side widths while the editor takes the remainder', () => {
        const result = resolveDockedPaneSizing({
            arrangement: 'editor', containerWidthPx: 1440, mainMinPx: 480, rightMinPx: 260, detailsMinPx: 480,
            rightWidthPx: 340, detailsWidthPx: 520, sessionWidthPx: 440, mainDocked: true,
            rightGlobalMinPx: 260, rightGlobalMaxPx: Infinity, detailsGlobalMinPx: 480,
            detailsGlobalMaxPx: Infinity, rightDocked: true, detailsDocked: true,
        });
        expect(result).toMatchObject({ mainWidthPx: 440, rightWidthPx: 340, detailsWidthPx: 660, mainMaxWidthPx: 620 });
    });
    it('shrinks right/details widths to preserve mainMinPx when both panes are docked', () => {
        const containerWidthPx = 1440;
        const result = resolveDockedPaneSizing({
            containerWidthPx,
            mainMinPx: PANE_SIZING_DEFAULTS.mainMinPx,
            rightMinPx: PANE_SIZING_DEFAULTS.right.minPx,
            detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
            rightWidthPx: 432,
            detailsWidthPx: 624,
            rightGlobalMinPx: PANE_SIZING_DEFAULTS.right.minPx,
            rightGlobalMaxPx: PANE_SIZING_DEFAULTS.right.maxPx,
            detailsGlobalMinPx: PANE_SIZING_DEFAULTS.details.minPx,
            detailsGlobalMaxPx: PANE_SIZING_DEFAULTS.details.maxPx,
            rightDocked: true,
            detailsDocked: true,
        });

        const budget = containerWidthPx - PANE_SIZING_DEFAULTS.mainMinPx;
        expect(result.rightWidthPx + result.detailsWidthPx).toBeLessThanOrEqual(budget);
        expect(result.rightWidthPx).toBeGreaterThanOrEqual(PANE_SIZING_DEFAULTS.right.minPx);
        expect(result.detailsWidthPx).toBeGreaterThanOrEqual(PANE_SIZING_DEFAULTS.details.minPx);
        // Max widths should reflect the remaining budget after reserving `mainMinPx`, not an arbitrary global cap.
        expect(result.rightMaxWidthPx).toBeLessThanOrEqual(budget);
        expect(result.detailsMaxWidthPx).toBeLessThanOrEqual(budget);
    });
});

