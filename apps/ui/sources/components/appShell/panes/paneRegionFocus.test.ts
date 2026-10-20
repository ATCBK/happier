import { describe, expect, it } from 'vitest';
import { createPaneRegionFocusModel } from './paneRegionFocus';

describe('pane region keyboard focus', () => {
  it('cycles visible regions in stable semantic order and wraps while skipping folded and hidden panes', () => {
    const model = createPaneRegionFocusModel();
    const visits: string[] = [];
    let focused = 'main';
    const register = (region: 'rail' | 'navigation' | 'right' | 'details' | 'main' | 'bottom', visible = true) => model.register(region, () => ({
      visible, containsFocus: focused === region, focus: () => { focused = region; visits.push(region); return true; },
    }));
    const cleanups = [register('main'), register('bottom'), register('rail'), register('navigation', false), register('details'), register('right', false)];
    expect(model.focus('next')).toBe(true);
    expect(model.focus('next')).toBe(true);
    expect(model.focus('previous')).toBe(true);
    expect(visits).toEqual(['bottom', 'rail', 'bottom']);
    cleanups.forEach(cleanup => cleanup());
    expect(model.focus('next')).toBe(false);
  });
  it('keeps the current focused destination authoritative when its previous registration retires', () => {
    const model = createPaneRegionFocusModel();
    const oldCleanup = model.register('main', () => ({ visible: true, containsFocus: false, focus: () => false }));
    model.register('main', () => ({ visible: true, containsFocus: false, focus: () => true }));
    oldCleanup();
    expect(model.focus('next')).toBe(true);
  });
});
