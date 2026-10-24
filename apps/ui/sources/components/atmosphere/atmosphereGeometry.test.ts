import { describe, expect, it } from 'vitest';
import { atmosphereBandSpan, atmospherePaneSpan, atmospherePictureFrame, atmosphereSceneRect, projectAtmosphereBand } from './atmosphereGeometry';

describe('shell atmosphere geometry', () => {
    const window = { x: 0, y: 0, width: 1440, height: 900 };
    const content = { x: 344, y: 40, width: 1088, height: 852 };
    it('Wallpaper covers the title, rail and sidebar; Horizon stays in the content pane', () => {
        expect(atmospherePictureFrame('wallpaper', window, content)).toEqual(window);
        expect(atmospherePictureFrame('horizon', window, content)).toEqual(content);
    });
    it('offsets adjacent panes into the same scene, including the eight pixel gutter', () => {
        const left = { x: 352, y: 48, width: 532, height: 836 };
        const right = { x: 892, y: 48, width: 532, height: 836 };
        expect(atmospherePaneSpan(window, left)).toEqual({ x: 352, y: 48, W: 1440, H: 900 });
        expect(atmospherePaneSpan(window, right)).toEqual({ x: 892, y: 48, W: 1440, H: 900 });
        expect(atmospherePaneSpan(content, right)).toEqual({ x: 548, y: 8, W: 1088, H: 852 });
    });
    it('ends the project band below the actual tabs, independent of pane height', () => {
        expect(projectAtmosphereBand({ pane: content, tabs: { x: 368, y: 158, width: 1040, height: 36 } })).toBe(154);
    });
    it('composes a narrow column\'s band at a page\'s scale, centred on the picture, and leaves wide bands as they are', () => {
        // A Project column beside its editor: the picture keeps the scale of a wide page column instead of
        // shrinking into a strip of tiny detail; the column shows the middle of that composition.
        expect(atmosphereBandSpan({ x: 990, y: 40, width: 440, height: 86 }, window)).toEqual({ x: 252, y: 0, W: 944, H: 86 });
        // Home and split panes are already at least that wide: unchanged.
        expect(atmosphereBandSpan(content, window)).toEqual({ x: 0, y: 0, W: 1088, H: 852 });
        // A phone's column is its window: never composed wider than the window.
        const phone = { x: 0, y: 0, width: 390, height: 844 };
        expect(atmosphereBandSpan({ x: 0, y: 0, width: 390, height: 120 }, phone)).toEqual({ x: 0, y: 0, W: 390, H: 120 });
    });
    it('uses one content scene across visible split panes without extending Horizon into chrome', () => {
        const left = { x: 352, y: 48, width: 532, height: 836 };
        const right = { x: 892, y: 48, width: 532, height: 836 };
        const scene = atmosphereSceneRect([left, right]);
        expect(scene).toEqual({ x: 352, y: 48, width: 1072, height: 836 });
        expect(atmospherePaneSpan(scene!, right)).toEqual({ x: 540, y: 0, W: 1072, H: 836 });
    });
});
