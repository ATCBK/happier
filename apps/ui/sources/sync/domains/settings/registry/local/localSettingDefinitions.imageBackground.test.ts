import { describe, expect, it } from 'vitest';

import { localSettingsParse } from '../../localSettings';

describe('image Background preference', () => {
    it('defaults to checkerboard by absence and remembers image and SVG choices independently', () => {
        expect(localSettingsParse({}).filesImageBackgroundByKind).toEqual({});
        const parsed = localSettingsParse({ filesImageBackgroundByKind: { image: 'dark', svg: 'light' } });
        expect(parsed.filesImageBackgroundByKind).toEqual({ image: 'dark', svg: 'light' });
        expect(localSettingsParse(parsed).filesImageBackgroundByKind).toEqual(parsed.filesImageBackgroundByKind);
    });

    it('recovers a malformed or future choice without resetting unrelated local settings', () => {
        expect(localSettingsParse({ sidebarCollapsed: true, filesImageBackgroundByKind: { image: 'automatic' } }))
            .toMatchObject({ sidebarCollapsed: true, filesImageBackgroundByKind: {} });
    });
});
