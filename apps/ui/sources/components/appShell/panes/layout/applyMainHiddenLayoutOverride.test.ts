import { describe, expect, it } from 'vitest';

import { applyMainHiddenLayoutOverride } from './applyMainHiddenLayoutOverride';

describe('applyMainHiddenLayoutOverride', () => {
    it('returns the base layout when focus mode is inactive', () => {
        const base = { main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' } as const;
        expect(applyMainHiddenLayoutOverride({
            mainHidden: false,
            rightOpen: true,
            detailsOpen: false,
            baseLayout: base,
        })).toEqual(base);
    });

    it('returns the base layout when no panes are open', () => {
        const base = { main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' } as const;
        expect(applyMainHiddenLayoutOverride({
            mainHidden: true,
            rightOpen: false,
            detailsOpen: false,
            baseLayout: base,
        })).toEqual(base);
    });

    it('forces threePane docked when both panes are open', () => {
        expect(applyMainHiddenLayoutOverride({
            mainHidden: true,
            rightOpen: true,
            detailsOpen: true,
            baseLayout: { main: 'docked', kind: 'overlayStack', right: 'hidden', details: 'overlay' },
        })).toEqual({ main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' });
    });

    it('forces right docked when only right is open', () => {
        expect(applyMainHiddenLayoutOverride({
            mainHidden: true,
            rightOpen: true,
            detailsOpen: false,
            baseLayout: { main: 'docked', kind: 'overlayStack', right: 'overlay', details: 'hidden' },
        })).toEqual({ main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' });
    });

    it('forces details docked when only details is open', () => {
        expect(applyMainHiddenLayoutOverride({
            mainHidden: true,
            rightOpen: false,
            detailsOpen: true,
            baseLayout: { main: 'docked', kind: 'overlayStack', right: 'hidden', details: 'overlay' },
        })).toEqual({ main: 'docked', kind: 'twoPane', right: 'hidden', details: 'docked' });
    });
});
