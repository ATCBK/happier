import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../../surfaceFixture.testSupport.js';
import { PluginUiProvider } from '../../components/PluginUiProvider.js';
import { ReviewSeverity } from '../../components/index.js';
import { HAPPIER_TONE_COLOR_TOKEN } from '../semantics.js';
import {
  HAPPIER_REVIEW_SEVERITY_TONE,
  type HappierReviewSeverity,
} from './ReviewSeverity.js';

const SEVERITIES: readonly HappierReviewSeverity[] = [
  'blocker',
  'high',
  'medium',
  'low',
  'nit',
];

function cssColor(color: string): string {
  const probe = document.createElement('div');
  probe.style.color = color;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

describe('review severity presentation', () => {
  it('gives every severity one colour role: failure, caution, then two steps of ink, never the accent', () => {
    expect(HAPPIER_REVIEW_SEVERITY_TONE).toEqual({
      blocker: 'danger',
      high: 'danger',
      medium: 'warning',
      low: 'secondary',
      nit: 'muted',
    });
  });

  it('draws each severity, as a label and as a badge, in the colour its shared tone names', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub()} context={context}>
        {SEVERITIES.map((severity) => (
          <ReviewSeverity
            key={severity}
            severity={severity}
            label={`${severity} words`}
            testID={`label-${severity}`}
          />
        ))}
        <ReviewSeverity
          severity="low"
          presentation="badge"
          label="low badge"
          testID="badge-low"
        />
      </PluginUiProvider>,
    );

    for (const severity of SEVERITIES) {
      const label = mount.container.querySelector<HTMLElement>(
        `[data-testid="label-${severity}"]`,
      )!;
      const words = [...label.querySelectorAll<HTMLElement>('*')].find(
        (node) =>
          node.textContent === `${severity} words` &&
          node.children.length === 0,
      )!;
      const expected = cssColor(
        context.theme.colors[
          HAPPIER_TONE_COLOR_TOKEN[HAPPIER_REVIEW_SEVERITY_TONE[severity]]
        ],
      );
      expect(getComputedStyle(words).color, severity).toBe(expected);
    }
    const badge = mount.container.querySelector<HTMLElement>(
      '[data-testid="badge-low"]',
    )!;
    const badgeWords = [...badge.querySelectorAll<HTMLElement>('*')].find(
      (node) => node.textContent === 'low badge' && node.children.length === 0,
    )!;
    expect(getComputedStyle(badgeWords).color).toBe(
      cssColor(context.theme.colors.secondaryText),
    );
    expect(getComputedStyle(badgeWords).color).not.toBe(
      cssColor(context.theme.colors.accent),
    );

    mount.unmount();
  });
});
