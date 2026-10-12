import type { AtmosphereRect } from './atmosphereStage';
import type { AtmosphereSpan } from '@happier-dev/brand/atmosphere';

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
