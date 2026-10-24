import type { AtmosphereRect } from './atmosphereStage';
import type { AtmosphereSpan } from '@happier-dev/brand/atmosphere';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

export function atmospherePictureFrame(layout: 'horizon' | 'wallpaper', window: AtmosphereRect, pane: AtmosphereRect): AtmosphereRect {
    return layout === 'wallpaper' ? window : pane;
}

export function atmospherePaneSpan(frame: AtmosphereRect, pane: AtmosphereRect): AtmosphereSpan {
    return { x: pane.x - frame.x, y: pane.y - frame.y, W: frame.width, H: frame.height };
}

export function atmosphereSceneRect(panes: readonly AtmosphereRect[]): AtmosphereRect | null {
    if (panes.length === 0) return null;
    const x = Math.min(...panes.map(pane => pane.x));
    const y = Math.min(...panes.map(pane => pane.y));
    return { x, y, width: Math.max(...panes.map(pane => pane.x + pane.width)) - x,
        height: Math.max(...panes.map(pane => pane.y + pane.height)) - y };
}

export function projectAtmosphereBand(input: Readonly<{ pane: AtmosphereRect; tabs: AtmosphereRect }>): number {
    return Math.max(0, input.tabs.y + input.tabs.height - input.pane.y);
}

/**
 * The virtual band a Horizon picture covers. A band composes the picture at least as wide as a page's wide
 * column, never wider than the window, so a narrow column (a Project beside its editor) shows the middle of
 * that composition, centred on the picture's focus, instead of the whole picture shrunk into a strip of tiny
 * detail. Its rows stay the band's own, so the dissolve still ends below the tabs.
 */
export function atmosphereBandSpan(scene: AtmosphereRect, window: Readonly<{ width: number }>): AtmosphereSpan {
    const W = Math.max(scene.width, Math.min(HAPPIER_PAGE_METRICS.columnMaxWidthPx.wide, window.width));
    return { x: (W - scene.width) / 2, y: 0, W, H: scene.height };
}
