import { afterEach, describe, expect, it, vi } from 'vitest';

async function importItemDensityMetricsForPlatform(os: 'ios' | 'web') {
    vi.resetModules();
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: os, select: (value: Record<string, unknown>) => value[os] ?? value.default } });
    });

    return await import('./itemDensityMetrics');
}

afterEach(() => {
    vi.doUnmock('react-native');
    vi.resetModules();
});

describe('itemDensityMetrics', () => {
    it('reserves extra room around comfortable iOS item icons', async () => {
        const { ITEM_ICON_BOX_SIZE } = await importItemDensityMetricsForPlatform('ios');

        expect(ITEM_ICON_BOX_SIZE.comfortable).toBeGreaterThan(29);
    });

    it('keeps the web comfortable icon box unchanged', async () => {
        const { ITEM_ICON_BOX_SIZE } = await importItemDensityMetricsForPlatform('web');

        expect(ITEM_ICON_BOX_SIZE.comfortable).toBe(32);
    });
});

describe('density text hierarchy', () => {
    // Each density draws its row text from the type-role table. A larger density must keep a real step
    // between title and description, and must never draw smaller text than a tighter one.
    for (const os of ['web', 'ios'] as const) {
        it(`keeps the description below the title and never grows as the density tightens (${os})`, async () => {
            const { ITEM_TITLE_TEXT_METRICS, ITEM_SUBTITLE_TEXT_METRICS } = await importItemDensityMetricsForPlatform(os);
            const { resolvePageRowMetrics } = await import('./pageRowMetrics');
            const item = (['comfortable', 'cozy', 'compact', 'tight'] as const).map((density) => ({
                title: ITEM_TITLE_TEXT_METRICS[density].fontSize,
                subtitle: ITEM_SUBTITLE_TEXT_METRICS[density].fontSize,
            }));
            const page = (['comfortable', 'cozy', 'compact'] as const).map((density) => {
                const metrics = resolvePageRowMetrics({ density, shape: 'standard', touch: false });
                return { title: metrics.title.fontSize, subtitle: metrics.subtitle.fontSize };
            });
            for (const ladder of [item, page]) {
                for (const step of ladder) expect(step.subtitle).toBeLessThan(step.title);
                for (let i = 1; i < ladder.length; i += 1) {
                    expect(ladder[i].title).toBeLessThanOrEqual(ladder[i - 1].title);
                    expect(ladder[i].subtitle).toBeLessThanOrEqual(ladder[i - 1].subtitle);
                }
                // The roomiest density is a visible step up from the default (cozy) title.
                expect(ladder[0].title).toBeGreaterThan(ladder[1].title);
            }
        });
    }
});

describe('itemDensityMetrics glyph vs box', () => {
    it('keeps every glyph size on the app icon scale', async () => {
        const { ITEM_ICON_GLYPH_SIZE } = await importItemDensityMetricsForPlatform('web');
        const { ICON_SIZE } = await import('@/components/ui/icons/Icon');

        // Deriving these from the row's own type metrics was tried and reverted: it read as oversized
        // and, because iOS and web use different line heights, it silently gave the two platforms
        // different icons. A scale step is the same number everywhere.
        const scale = new Set<number>(Object.values(ICON_SIZE));
        for (const density of ['comfortable', 'cozy', 'compact', 'tight'] as const) {
            expect(scale.has(ITEM_ICON_GLYPH_SIZE[density])).toBe(true);
        }
    });

    it('resolves to the same glyph size on iOS and web', async () => {
        const ios = await importItemDensityMetricsForPlatform('ios');
        const web = await importItemDensityMetricsForPlatform('web');

        expect(ios.ITEM_ICON_GLYPH_SIZE).toEqual(web.ITEM_ICON_GLYPH_SIZE);
    });

    it('shrinks monotonically as the density tightens', async () => {
        const { ITEM_ICON_GLYPH_SIZE } = await importItemDensityMetricsForPlatform('web');

        const order = ['comfortable', 'cozy', 'compact', 'tight'] as const;
        for (let i = 1; i < order.length; i += 1) {
            expect(ITEM_ICON_GLYPH_SIZE[order[i]]).toBeLessThanOrEqual(ITEM_ICON_GLYPH_SIZE[order[i - 1]]);
        }
    });
});

describe('menu row metrics', () => {
    it('does not vary with the list density setting', async () => {
        const { MENU_ROW_METRICS } = await importItemDensityMetricsForPlatform('web');

        // A dropdown is a dropdown. The density setting sizes the user's LISTS — settings rows,
        // file trees — and letting it reach a transient menu made the same menu render at four
        // different heights depending on a preference set somewhere else entirely.
        expect(Object.values(MENU_ROW_METRICS).every((value) => typeof value === 'number')).toBe(true);
    });

    it('resolves identically on iOS and web', async () => {
        const ios = await importItemDensityMetricsForPlatform('ios');
        const web = await importItemDensityMetricsForPlatform('web');

        expect(ios.MENU_ROW_METRICS).toEqual(web.MENU_ROW_METRICS);
    });

    it('is tighter than the tightest item row', async () => {
        const { MENU_ROW_METRICS, ITEM_ICON_GLYPH_SIZE, ITEM_ICON_BOX_SIZE } = await importItemDensityMetricsForPlatform('web');

        // The regression this pins: dropdown rows that render through `Item` used to inherit the
        // settings-row scale — a 20px glyph in a 24px box on a 44px row — while the dropdown rows
        // that render through `SelectableRow` sat at 16 on 36. One concept, two sizes, decided by
        // which component the call site happened to reach for.
        const tightestItemGlyph = Math.min(...Object.values(ITEM_ICON_GLYPH_SIZE));
        const tightestItemBox = Math.min(...Object.values(ITEM_ICON_BOX_SIZE));
        expect(MENU_ROW_METRICS.iconGlyphSizePx).toBeLessThanOrEqual(tightestItemGlyph);
        expect(MENU_ROW_METRICS.iconBoxSizePx).toBeLessThanOrEqual(tightestItemBox);
    });

    it('keeps its glyph on the app icon scale', async () => {
        const { MENU_ROW_METRICS } = await importItemDensityMetricsForPlatform('web');
        const { ICON_SIZE } = await import('@/components/ui/icons/Icon');

        expect(new Set<number>(Object.values(ICON_SIZE)).has(MENU_ROW_METRICS.iconGlyphSizePx)).toBe(true);
    });
});
