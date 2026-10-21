import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLIC_PROFILE_POLICY_V1,
  PublicProfileSnapshotV1Schema,
} from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfile } from '@happier-dev/protocol/account/projectPublicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';

import { HappierUiEnvironmentProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import {
  HappierPublicProfile,
  type HappierPublicProfileLabels,
} from './PublicProfile.js';

const coverage = { status: 'partial', method: 'mixed' } as const;
const snapshot = PublicProfileSnapshotV1Schema.parse({
  v: 1,
  computedAtMs: 10,
  period: { startMs: 1, endMs: 9, timeZoneOffsetMinutes: 0 },
  coverage,
  facts: { tokens: 87654321, activeDays: 17, peakParallel: 6 },
  fieldCoverage: { tokens: coverage, activeDays: coverage },
});
const metric = (
  id: string,
  label: string,
  field: string,
  size: 'medium' | 'wide',
) =>
  ({
    kind: 'widget',
    id,
    size,
    frameStyle: 'card',
    presentation: {
      kind: 'declarative',
      document: {
        version: 1,
        root: {
          kind: 'metric',
          label,
          data: { kind: 'value', value: { kind: 'public_profile' } },
          value: { path: ['snapshot', 'facts', field], type: 'number' },
        },
      },
    },
  }) as const;
const context = {
  handle: 'leeroy',
  identity: { name: 'Leeroy Brun', sinceMs: 1 },
  service: {
    displayName: 'Happier Cloud',
    publicBaseUrl: 'https://happier.dev',
  },
  urls: {
    page: 'https://happier.dev/@leeroy',
    json: 'https://happier.dev/v1/public/profiles/leeroy',
    badgeBase: 'https://happier.dev/@leeroy/badge',
    card: 'https://happier.dev/@leeroy/card.svg',
    og: 'https://happier.dev/@leeroy/og.png',
    report: 'mailto:operator@happier.dev',
  },
};
const labels: HappierPublicProfileLabels = {
  identityLine: '@leeroy · Happier Cloud',
  periodTitle: 'Last 90 days',
  periodDetail: '8 Jul – 5 Oct 2026',
  emptyLayout: 'Nothing here yet',
  footerNote: 'Totals only.',
  report: 'Report',
  madeWith: 'Made with Happier',
  inert: {
    success: 'Success',
    warning: 'Warning',
    error: 'Error',
    incomplete: 'More',
  },
};

function render(policy = DEFAULT_PUBLIC_PROFILE_POLICY_V1) {
  const view = projectPublicProfile({
    context,
    policy,
    metadata: {
      bio: 'Steering agents from a phone.',
      links: [{ label: 'leeroy.dev', url: 'https://leeroy.dev' }],
    },
    snapshot,
    appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    layout: {
      v: 1,
      items: [
        metric('tokens', 'Tokens', 'tokens', 'medium'),
        metric('days', 'Active days', 'activeDays', 'medium'),
        metric('peak', 'At once', 'peakParallel', 'wide'),
      ],
    },
  });
  if (!view) throw new Error('expected a published view');
  return mountThroughReactNativeWeb(
    createElement(HappierUiEnvironmentProvider, {
      environment: projectHappierUiEnvironment(createSurfaceContext()),
      children: createElement(HappierPublicProfile, { view, labels }),
    }),
  );
}

describe('HappierPublicProfile', () => {
  it('draws the applied identity, period and placed blocks with real links and no controls', () => {
    const mounted = render();
    try {
      const text = mounted.container.textContent ?? '';
      expect(text).toContain('Leeroy Brun');
      expect(text).toContain('Last 90 days');
      expect(text).toContain('Steering agents from a phone.');
      expect(
        mounted.container.querySelector(
          '[data-testid="public-profile-block-peak"]',
        )?.textContent,
      ).toContain('6');
      const report = mounted.container.querySelector(
        'a[href="mailto:operator@happier.dev"]',
      );
      expect(report?.textContent).toBe('Report');
      expect(
        mounted.container
          .querySelector('a[href="https://leeroy.dev"]')
          ?.getAttribute('rel'),
      ).toContain('ugc');
      expect(
        mounted.container.querySelectorAll('button, [role="button"]'),
      ).toHaveLength(0);
    } finally {
      mounted.unmount();
    }
  });

  it('never draws a hidden fact or its empty block, because the projected view has neither', () => {
    const mounted = render({
      ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false },
    });
    try {
      expect(mounted.container.textContent).not.toContain('87654321');
      expect(mounted.container.textContent).not.toContain('87,654,321');
      expect(
        mounted.container.querySelector(
          '[data-testid="public-profile-block-tokens"]',
        ),
      ).toBeNull();
      expect(
        mounted.container.querySelector(
          '[data-testid="public-profile-block-days"]',
        ),
      ).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});
