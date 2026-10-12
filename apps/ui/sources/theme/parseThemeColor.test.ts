/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';

import { parseThemeColor, readThemeDocumentColor } from './parseThemeColor';
import { resolveHeatmapColor } from '@/components/ui/charts/heatmapColorScale';
import { resolveXtermFindColors } from '@/components/terminal/xterm/findColors';
import { atmospherePageRgb } from '@/components/atmosphere/atmospherePage';

afterEach(() => document.documentElement.removeAttribute('style'));

describe('theme colour parsing boundary', () => {
    it('keeps literals and resolves the live root value of a Unistyles CSS variable', () => {
        document.documentElement.style.setProperty('--colors-surface-elevated', '#221c1c');

        expect(readThemeDocumentColor(document, 'var(--colors-surface-elevated)')).toBe('#221c1c');
        expect(parseThemeColor('#112233')?.hex().toLowerCase()).toBe('#112233');
        expect(parseThemeColor('var(--colors-surface-elevated)')?.hex().toLowerCase()).toBe('#221c1c');
    });

    it('does not invent a colour when a variable or literal cannot be parsed', () => {
        expect(readThemeDocumentColor(document, 'var(--colors-missing)')).toBeNull();
        expect(parseThemeColor('var(--colors-missing)')).toBeNull();
        expect(parseThemeColor('not-a-colour')).toBeNull();
    });

    it('resolves live theme tokens before numeric chart, terminal and atmosphere colour math', () => {
        const token = 'var(--colors-surface-elevated)';
        const ink = 'var(--colors-text-primary)';
        for (const [surface, foreground] of [['#ffffff', '#121212'], ['#221c1c', '#f4f4f4']] as const) {
            document.documentElement.style.setProperty('--colors-surface-elevated', surface);
            document.documentElement.style.setProperty('--colors-text-primary', foreground);
            expect(resolveHeatmapColor({ value: 2, values: [1, 2, 3], baseColor: ink, emptyColor: token }))
                .toBe(resolveHeatmapColor({ value: 2, values: [1, 2, 3], baseColor: foreground, emptyColor: surface }));
            expect(resolveXtermFindColors({ matchAll: ink, matchCurrent: ink }, token))
                .toEqual(resolveXtermFindColors({ matchAll: foreground, matchCurrent: foreground }, surface));
            expect(atmospherePageRgb(token)).toEqual(atmospherePageRgb(surface));
        }
    });
});
