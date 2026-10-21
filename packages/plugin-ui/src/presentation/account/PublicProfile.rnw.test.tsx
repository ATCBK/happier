import { act, createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLIC_PROFILE_POLICY_V1,
  PublicProfileSnapshotV1Schema,
} from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfile, projectPublicProfilePreview } from '@happier-dev/protocol/account/projectPublicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileReadResultV1Schema, PublicProfilePreparedAppearanceV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';

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
    title: `${label} block`,
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

function render(policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
  fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, bio: true, links: true } }) {
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
        { kind: 'group', id: 'work', title: 'Observed work', width: 'full', frameStyle: 'plain', dividers: 'none',
          children: [metric('peak', 'At once', 'peakParallel', 'wide')] },
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
  it('renders a real local picture preview through the same placed tree and its host-owned hero slot', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
    const appearance = PublicProfilePreparedAppearanceV1Schema.parse({ theme: 'light', atmosphere: {
      source: 'picture', picture: { layout: 'horizon', descriptor: {
        kind: 'photo', title: 'Reviewed image', credit: null, adaptiveHaze: false, horizon: {}, focus: {},
        hour: 0, grades: { light: 0, dusk: 0, night: 0 }, dark: 'night',
        look: { effect: 'mosaic', params: {}, strength: 0.37, dissolve: { style: 'rows', from: 0.58, to: 1 } },
      }, content: { mimeType: 'image/png', base64: png } },
    } });
    const view = projectPublicProfilePreview({ context,
      policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } },
      metadata: {}, snapshot, appearance,
      layout: { v: 1, items: [metric('tokens', 'Tokens', 'tokens', 'medium'), metric('peak', 'At once', 'peakParallel', 'wide')] },
    });
    if (!view || view.appearance.atmosphere.source !== 'picture') throw new Error('expected a local picture preview');
    const picture = view.appearance.atmosphere.picture;
    const mounted = mountThroughReactNativeWeb(createElement(HappierUiEnvironmentProvider, {
      environment: projectHappierUiEnvironment(createSurfaceContext()),
      children: createElement(HappierPublicProfile, { view, labels,
        // The physical atmosphere renderer is a host boundary; this fixture observes the exact retained input.
        renderHero: () => createElement('img', { alt: picture.descriptor.title,
          src: `data:${picture.content.mimeType};base64,${picture.content.base64}`, 'data-testid': 'local-picture' }),
      }),
    }));
    try {
      expect(mounted.container.querySelector('[data-testid="local-picture"]')?.getAttribute('src')).toBe(`data:image/png;base64,${png}`);
      expect(mounted.container.querySelector('[data-testid="public-profile-block-peak"]')?.textContent).toContain('6');
      expect(mounted.container.querySelector('[data-testid="public-profile-block-tokens"]')).toBeNull();
      expect(mounted.container.textContent).not.toContain('87654321');
    } finally { mounted.unmount(); }
  });
  it.each([true, false])('distinguishes selected missing calendar from hidden calendar (selected: %s)', selected => {
    const view = projectPublicProfile({ context, policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, calendar: selected } },
      metadata: {}, snapshot, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      layout: { v: 1, items: [{ kind: 'widget', id: 'missing-sky', title: 'Shared sky', size: 'wide', frameStyle: 'plain',
        presentation: { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'sky' } } }] },
    });
    if (!view) throw new Error('expected a published view');
    const mounted = mountThroughReactNativeWeb(createElement(HappierUiEnvironmentProvider, {
      environment: projectHappierUiEnvironment(createSurfaceContext()),
      children: createElement(HappierPublicProfile, { view, labels, usage: {
        paint: { accent: '#007aff', paper: '#ffffff', dark: false },
        agent: id => ({ id, name: id, color: '#007aff' }),
        labels: { chartLabel: () => 'Shared activity', unavailable: 'Activity not recorded' },
      } }),
    }));
    try {
      const block = mounted.container.querySelector('[data-testid="public-profile-block-missing-sky"]');
      if (selected) expect(block?.textContent).toContain('Activity not recorded');
      else expect(block).toBeNull();
      expect(block?.textContent ?? '').not.toMatch(/\b0 days\b/u);
    } finally { mounted.unmount(); }
  });
  it('renders copied Usage bodies from the real projected view, with ordinal unknowns and share-only Agent rows', () => {
    const publicSnapshot = PublicProfileSnapshotV1Schema.parse({ ...snapshot,
      period: { startMs: Date.UTC(2026, 8, 1), endMs: Date.UTC(2026, 8, 8), timeZoneOffsetMinutes: 0 },
      facts: { ...snapshot.facts, calendar: [{ date: '2026-09-01', level: 4 }, { date: '2026-09-02', level: null }, { date: '2026-09-03', level: 0 }],
        agentMix: [{ agentId: 'codex', share: 0.75, tokens: 87654321, coverage },
          { agentId: 'claude', share: 0.25, tokens: 12345678, coverage: { status: 'unknown', method: 'context_only' } }] },
    });
    const view = projectPublicProfile({ context, policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false, calendar: true, agentMix: true } },
      metadata: {}, snapshot: publicSnapshot, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      layout: { v: 1, items: [
        { kind: 'widget', id: 'sky', title: 'Shared sky', size: 'wide', frameStyle: 'plain',
          presentation: { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'sky' } } },
        { kind: 'group', id: 'agents', width: 'full', frameStyle: 'plain', dividers: 'none', children: [
          { kind: 'widget', id: 'crew', title: 'Agent shares', size: 'medium', frameStyle: 'plain',
            presentation: { kind: 'usage', widgetId: 'usage_breakdowns', inputs: { style: 'crew' } } },
        ] },
      ] },
    });
    if (!view) throw new Error('expected a published view');
    const usage = {
      paint: { accent: '#007aff', paper: '#ffffff', dark: false }, width: 640,
      agent: (id: string) => ({ id, name: id === 'codex' ? 'Codex' : 'Claude Code', color: '#007aff' }),
      labels: { chartLabel: () => 'Shared activity', unavailable: 'Not recorded',
        crew: { percent: (share: number) => `${share * 100}%`, days: (days: number) => `${days} days` },
        sky: { formatValue: (value: number) => `PRIVATE AMOUNT ${value}`, month: (date: string) => date, day: (date: string) => date,
          levels: { quiet: 'Quiet', steady: 'Steady', busy: 'Busy', busiest: 'Busiest' },
          streakBestOngoing: (days: number) => `Best ongoing ${days}`, streakBest: (days: number) => `Best ${days}`,
          streakNow: (days: number) => `Current ${days}`, streakShort: (days: number) => `${days} days`,
          key: { tie: 'Tie', notAttributed: 'Not attributed', noActivity: 'No activity', notRecorded: 'Not recorded', quieter: 'Quieter', busier: 'Busier' },
          caption: 'Shared ordinal activity', values: { show: 'Show values', hide: 'Hide values', dateColumn: 'Day', valueColumn: 'Level',
            leaderColumn: 'Agent', noActivity: 'No activity', notRecorded: 'Not recorded', tie: 'Tie', notAttributed: 'Not attributed' } },
      },
    };
    const mounted = mountThroughReactNativeWeb(createElement(HappierUiEnvironmentProvider, {
      environment: projectHappierUiEnvironment(createSurfaceContext()),
      children: createElement(HappierPublicProfile, { view, labels, usage }),
    }));
    try {
      expect(mounted.container.querySelector('[data-testid="public-profile-usage-crew"]')?.textContent).toContain('Codex');
      expect(mounted.container.textContent).toContain('75%');
      expect(mounted.container.textContent).not.toContain('25%');
      expect(mounted.container.textContent).not.toContain('PRIVATE AMOUNT');
      expect(mounted.container.textContent).not.toContain('87654321');
      const values = mounted.container.querySelector<HTMLElement>('[data-testid="public-profile-usage-sky-values-toggle"]');
      expect(values).not.toBeNull();
      act(() => values!.click());
      const sky = mounted.container.querySelector('[data-testid="public-profile-usage-sky-values"]')?.textContent;
      expect(sky).toContain('2026-09-01Busiest');
      expect(sky).toContain('2026-09-02Not recorded');
      expect(sky).toContain('2026-09-03No activity');
    } finally { mounted.unmount(); }
  });
  it.each([
    { kind: 'unavailable' },
    { kind: 'paused', handle: 'ada', identity: { name: 'Ada Lovelace' } },
  ] as const)('renders $kind without fabricating a published view or period', input => {
    const result = PublicProfileReadResultV1Schema.parse(input);
    if (result.kind === 'published') throw new Error('Expected a non-published result');
    const mounted = mountThroughReactNativeWeb(createElement(HappierUiEnvironmentProvider, {
      environment: projectHappierUiEnvironment(createSurfaceContext()),
      children: createElement(HappierPublicProfile, { result,
        labels: { paused: 'This profile is paused', unavailable: 'Profile unavailable' } }),
    }));
    try {
      expect(mounted.container.textContent).toContain(input.kind === 'paused' ? 'This profile is paused' : 'Profile unavailable');
      if (input.kind === 'paused') expect(mounted.container.textContent).toContain('Ada Lovelace');
      expect(mounted.container.textContent).not.toContain('Last 90 days');
      expect(mounted.container.textContent).not.toContain('87,654,321');
      expect(mounted.container.querySelector('[data-testid="public-profile-block-tokens"]')).toBeNull();
    } finally { mounted.unmount(); }
  });
  it('draws the applied identity, period and placed blocks with real links and no controls', () => {
    const mounted = render();
    try {
      const text = mounted.container.textContent ?? '';
      expect(text).toContain('Leeroy Brun');
      expect(text).toContain('Last 90 days');
      expect(text).toContain('Steering agents from a phone.');
      expect(text).toContain('At once block');
      expect(text).toContain('Tokens block');
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
