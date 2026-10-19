import { describe, expect, it, vi } from 'vitest';

import {
  HappierListOverflowFooter,
  leadHappierListRows,
} from '@happier-dev/plugin-ui/presentation';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';

const theme = SURFACE_CONTEXT_THEME_FIXTURE;

describe('leadHappierListRows', () => {
  it('leads a long list with its first rows and keeps a short tail whole', () => {
    const rows = Array.from({ length: 16 }, (_, index) => index);
    expect(leadHappierListRows(rows, false)).toEqual({
      rows: rows.slice(0, 6),
      hidden: 10,
    });
    expect(leadHappierListRows(rows, true)).toEqual({ rows, hidden: 0 });
    // Two rows behind a disclosure are only noise: eight rows show whole.
    expect(leadHappierListRows(rows.slice(0, 8), false)).toEqual({
      rows: rows.slice(0, 8),
      hidden: 0,
    });
  });
});

describe('HappierListOverflowFooter', () => {
  it('states the listed total and what is not in the list once, on one footer', () => {
    const onToggle = vi.fn();
    const mount = mountThroughReactNativeWeb(
      <HappierListOverflowFooter
        theme={theme}
        label="Projections"
        total={12}
        hidden={6}
        expanded={false}
        onToggle={onToggle}
        unlisted="10 windows not reported"
        testID="footer"
      />,
    );
    try {
      const footer = mount.container.querySelector('[data-testid="footer"]')!;
      expect(footer.textContent).toBe('Show all · 12·10 windows not reported');
      const toggle = mount.container.querySelector(
        '[data-testid="footer.toggle"]',
      ) as HTMLElement;
      expect(toggle.getAttribute('aria-label')).toBe(
        'Projections: Show all · 12',
      );
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      toggle.click();
      expect(onToggle).toHaveBeenCalledTimes(1);
    } finally {
      mount.unmount();
    }
  });

  it('collapses back with Show less and says an incomplete list shows what is available', async () => {
    const mount = mountThroughReactNativeWeb(
      <HappierListOverflowFooter
        theme={theme}
        label="Models"
        total={20}
        hidden={0}
        expanded
        complete={false}
        onToggle={() => {}}
        testID="footer"
      />,
    );
    try {
      expect(
        mount.container.querySelector('[data-testid="footer"]')!.textContent,
      ).toBe('Show less');
      expect(
        mount.container
          .querySelector('[data-testid="footer.toggle"]')!
          .getAttribute('aria-expanded'),
      ).toBe('true');
      await mount.render(
        <HappierListOverflowFooter
          theme={theme}
          label="Models"
          total={20}
          hidden={14}
          expanded={false}
          complete={false}
          onToggle={() => {}}
          labels={{ showAvailable: 'Afficher les disponibles' }}
          testID="footer"
        />,
      );
      expect(
        mount.container.querySelector('[data-testid="footer"]')!.textContent,
      ).toBe('Afficher les disponibles · 20');
    } finally {
      mount.unmount();
    }
  });

  it('draws only the unlisted note when every listed row is already shown, and nothing when there is nothing to say', async () => {
    const mount = mountThroughReactNativeWeb(
      <HappierListOverflowFooter
        theme={theme}
        label="Projections"
        total={3}
        hidden={0}
        expanded={false}
        onToggle={() => {}}
        unlisted="2 windows not reported"
        testID="footer"
      />,
    );
    try {
      expect(
        mount.container.querySelector('[data-testid="footer.toggle"]'),
      ).toBeNull();
      expect(
        mount.container.querySelector('[data-testid="footer"]')!.textContent,
      ).toBe('2 windows not reported');
      await mount.render(
        <HappierListOverflowFooter
          theme={theme}
          label="Projections"
          total={3}
          hidden={0}
          expanded={false}
          onToggle={() => {}}
          testID="footer"
        />,
      );
      expect(
        mount.container.querySelector('[data-testid="footer"]'),
      ).toBeNull();
    } finally {
      mount.unmount();
    }
  });
});
