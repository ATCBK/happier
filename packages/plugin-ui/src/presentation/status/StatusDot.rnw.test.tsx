import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierStatusDot } from './StatusDot.js';

function byTestId(container: HTMLElement, testID: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
}

describe('HappierStatusDot', () => {
  it('draws its halo as a concentric ring twice the dot size, in the halo colour', () => {
    const mounted = mountThroughReactNativeWeb(
      <HappierStatusDot color="rgb(0, 128, 0)" halo="rgb(152, 251, 152)" size={8} testID="status-dot" />,
    );
    try {
      const halo = byTestId(mounted.container, 'status-dot-halo');
      const dot = byTestId(mounted.container, 'status-dot');
      expect(halo).toBeTruthy();
      expect(halo!.style.backgroundColor).toBe('rgb(152, 251, 152)');
      expect(halo!.style.width).toBe('16px');
      expect(halo!.style.height).toBe('16px');
      // The dot keeps its own colour, size and accessibility identity inside the ring.
      expect(halo!.contains(dot)).toBe(true);
      expect(dot!.style.backgroundColor).toBe('rgb(0, 128, 0)');
      expect(dot!.style.width).toBe('8px');
      expect(dot!.getAttribute('aria-hidden')).toBe('true');
    } finally {
      mounted.unmount();
    }
  });

  it('draws a state glyph by shape in the status colour, and keeps the dot for unread news', () => {
    const glyph = mountThroughReactNativeWeb(
      <HappierStatusDot color="rgb(217, 119, 6)" glyph="review" size={14} testID="status" accessibilityLabel="Needs permission" />,
    );
    try {
      const slot = byTestId(glyph.container, 'status');
      expect(slot!.style.width).toBe('14px');
      expect(slot!.querySelector('svg')).not.toBeNull();
      expect(slot!.querySelector('path')?.getAttribute('stroke')).toBe('rgb(217, 119, 6)');
      expect(slot!.style.backgroundColor).toBe('');
      expect(slot!.getAttribute('aria-label')).toBe('Needs permission');
    } finally {
      glyph.unmount();
    }
    const unread = mountThroughReactNativeWeb(<HappierStatusDot color="rgb(0, 0, 0)" glyph="new" size={6} testID="status" />);
    try {
      expect(byTestId(unread.container, 'status')!.querySelector('svg')).toBeNull();
      expect(byTestId(unread.container, 'status')!.style.backgroundColor).toBe('rgb(0, 0, 0)');
    } finally {
      unread.unmount();
    }
  });

  it('draws no ring when no halo is asked for', () => {
    const mounted = mountThroughReactNativeWeb(<HappierStatusDot color="red" size={8} testID="status-dot" />);
    try {
      expect(byTestId(mounted.container, 'status-dot-halo')).toBeNull();
      expect(byTestId(mounted.container, 'status-dot')).toBeTruthy();
    } finally {
      mounted.unmount();
    }
  });

  it('keeps a named status announced rather than hiding it with its decorative halo', () => {
    const mounted = mountThroughReactNativeWeb(
      <HappierStatusDot color="green" halo="white" accessibilityLabel="Connected" testID="status-dot" />,
    );
    try {
      const dot = byTestId(mounted.container, 'status-dot');
      expect(dot?.getAttribute('aria-hidden')).not.toBe('true');
      expect(dot?.getAttribute('role')).toBe('img');
      expect(dot?.getAttribute('aria-label')).toBe('Connected');
    } finally {
      mounted.unmount();
    }
  });
});
