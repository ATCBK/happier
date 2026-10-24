import { act, createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLIC_PROFILE_POLICY_V1,
  PublicProfileSnapshotV1Schema,
} from '@happier-dev/protocol/account/publicProfile';
import {
  projectPublicProfile,
  projectPublicProfilePreview,
} from '@happier-dev/protocol/account/projectPublicProfile';
import {
  DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
  PublicProfileReadResultV1Schema,
  PublicProfilePreparedAppearanceV1Schema,
  PublicProfileLayoutV1Schema,
} from '@happier-dev/protocol/account/publicProfilePublication';

import { HappierUiEnvironmentProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import type { UsageDayLabels } from '../usage/charts/UsageDayInAgents.js';
import {
  HAPPIER_PUBLIC_PROFILE_HERO_METRICS,
  HappierPublicProfile,
  type HappierPublicProfileLabels,
} from '../../components/PublicProfile.js';
import type { PublicUsageOriginalLabels } from './PublicProfileUsage.js';

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
const originalLabels: PublicUsageOriginalLabels = {
  metrics: {
    tokens: 'Tokens',
    activeDays: 'Active days',
    agentTimeMs: 'Agent time',
    mergedPrs: 'Merged PRs',
    currentStreakDays: 'Current streak',
    bestStreakDays: 'Best streak',
    peakParallel: 'Peak',
  },
  formatMetric: (_kind, value) => String(value),
  activityLevel: 'Activity level',
  level: (value) => `Level ${value}`,
  date: (date) => date,
  weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  clock: (hour) => `${hour}:00`,
  showValues: 'Show values',
  hideValues: 'Hide values',
  agentMix: 'Agent mix',
  sourceSplit: 'Sources',
  source: (source) => source,
  percent: (share) => `${share * 100}%`,
  coverage: {
    title: 'Coverage',
    columns: ['Source', 'Coverage'],
    status: (status) => status,
    method: (method) => method,
  },
  footprint: {
    title: 'Insufficient basis',
    reason: 'No applicable method',
    noEstimate: 'No estimate',
    accounted: 'Accounted',
    tokensUnit: 'tokens',
    proxy: 'Proxy',
    proxyDetail: 'Not a measurement',
    methodTitle: 'Method',
    methodBody: 'Published methods only',
  },
  period: 'Shared period',
};

function render(
  policy = {
    ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
    fields: {
      ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
      bio: true,
      links: true,
    },
  },
) {
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
        {
          kind: 'group',
          id: 'work',
          title: 'Observed work',
          width: 'full',
          frameStyle: 'plain',
          dividers: 'none',
          children: [metric('peak', 'At once', 'peakParallel', 'wide')],
        },
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
  it.each([
    ['usage_daily', {}, 'Activity level'],
    ['usage_period_summary', {}, 'Active days'],
    ['usage_footprint', {}, 'No estimate'],
    ['usage_source_coverage', {}, 'partial'],
    ['usage_rhythm', { style: 'heatmap' }, 'Activity level'],
    ['usage_rhythm', { style: 'weekdayHour' }, 'Activity level'],
    ['usage_breakdowns', { style: 'breakdowns' }, '60%'],
    ['usage_outcomes', { style: 'outcomes' }, '0'],
    ['usage_recap', { style: 'recap' }, 'Active days'],
  ])(
    'mounts the shared original %s %j with permitted facts and no private amounts',
    (widgetId, inputs, content) => {
      const view = projectPublicProfile({
        context,
        metadata: {},
        appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
        policy: {
          ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
          fields: {
            ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
            tokens: false,
            footprint: true,
            punch: true,
            bestStreak: false,
          },
        },
        snapshot: PublicProfileSnapshotV1Schema.parse({
          ...snapshot,
          period: {
            startMs: Date.UTC(2026, 0, 1),
            endMs: Date.UTC(2026, 0, 4),
            timeZoneOffsetMinutes: 0,
          },
          facts: {
            tokens: 87654321,
            activeDays: 2,
            bestStreakDays: 9876,
            mergedPrs: 0,
            calendar: [
              { date: '2026-01-01', level: 4 },
              { date: '2026-01-02', level: null },
              { date: '2026-01-03', level: 0 },
            ],
            punch: [{ weekday: 1, hour: 10, level: 3 }],
            agentMix: [
              { agentId: 'codex', share: 0.6, tokens: 87654321, coverage },
              {
                agentId: 'claude',
                share: 0.4,
                tokens: 654321,
                coverage: { status: 'unknown', method: 'context_only' },
              },
            ],
            footprint: {
              status: 'insufficient_basis',
              reason: 'no_applicable_versioned_method',
            },
            highlights: [{ kind: 'active_days', count: 2 }],
          },
        }),
        layout: PublicProfileLayoutV1Schema.parse({
          v: 1,
          items: [
            {
              kind: 'widget',
              id: 'original',
              title: 'Shared original',
              size: 'wide',
              frameStyle: 'plain',
              presentation: { kind: 'usage', widgetId, inputs },
            },
          ],
        }),
      });
      if (!view) throw new Error('expected admitted original');
      const mounted = mountThroughReactNativeWeb(
        createElement(HappierUiEnvironmentProvider, {
          environment: projectHappierUiEnvironment(createSurfaceContext()),
          children: createElement(HappierPublicProfile, {
            view,
            labels,
            usage: {
              width: 480,
              paint: { accent: '#007aff', paper: '#ffffff', dark: false },
              agent: (id) => ({ id, name: id, color: '#007aff' }),
              labels: {
                chartLabel: () => 'Shared original',
                unavailable: 'Not shared',
                original: originalLabels,
              },
            },
          }),
        }),
      );
      try {
        const block = mounted.container.querySelector(
          '[data-testid="public-profile-block-original"]',
        );
        expect(block?.textContent).toContain(content);
        expect(
          block?.querySelector(
            '[data-testid="public-profile-usage-original-unavailable"]',
          ),
        ).toBeNull();
        expect(mounted.container.innerHTML).not.toMatch(/87654321|654321|9876/);
        if (widgetId === 'usage_daily') {
          const show = block?.querySelector<HTMLElement>(
            '[data-testid="public-profile-usage-original.chart-values-toggle"]',
          );
          if (show) act(() => show.click());
          expect(block?.textContent).not.toContain('87654321');
        }
        if (widgetId === 'usage_footprint')
          expect(
            block?.querySelector(
              '[data-testid="public-profile-usage-original.tokens"]',
            ),
          ).toBeNull();
      } finally {
        mounted.unmount();
      }
    },
  );
  it('does not invent original Recap highlights from separately shared totals when highlight evidence is absent', () => {
    const view = projectPublicProfile({
      context,
      metadata: {},
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      snapshot,
      layout: {
        v: 1,
        items: [
          {
            kind: 'widget',
            id: 'recap-missing',
            title: 'Recap',
            size: 'wide',
            frameStyle: 'plain',
            presentation: {
              kind: 'usage',
              widgetId: 'usage_recap',
              inputs: {},
            },
          },
        ],
      },
    });
    if (!view) throw new Error('expected admitted recap placement');
    const mounted = mountThroughReactNativeWeb(
      createElement(HappierUiEnvironmentProvider, {
        environment: projectHappierUiEnvironment(createSurfaceContext()),
        children: createElement(HappierPublicProfile, {
          view,
          labels,
          usage: {
            paint: { accent: '#007aff', paper: '#ffffff', dark: false },
            agent: (id) => ({ id, name: id, color: '#007aff' }),
            labels: {
              chartLabel: () => 'Recap',
              unavailable: 'No highlights recorded',
              original: originalLabels,
            },
          },
        }),
      }),
    );
    try {
      const block = mounted.container.querySelector(
        '[data-testid="public-profile-block-recap-missing"]',
      );
      expect(block?.textContent).toContain('No highlights recorded');
      expect(block?.textContent).not.toContain('Active days');
      expect(block?.textContent).not.toContain('87654321');
    } finally {
      mounted.unmount();
    }
  });
  it.each([true, false])(
    'feeds only permitted period records and anonymous durations to the existing shared records body (recorded: %s)',
    (recorded) => {
      const view = projectPublicProfile({
        context,
        policy: {
          ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
          fields: {
            ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
            activeDays: false,
            currentStreak: true,
            bestStreak: false,
            peakParallel: false,
            sessionDurations: true,
          },
        },
        metadata: {},
        snapshot: PublicProfileSnapshotV1Schema.parse({
          ...snapshot,
          facts: {
            activeDays: 17,
            bestStreakDays: 51,
            peakParallel: 9876,
            ...(recorded
              ? {
                  currentStreakDays: 3,
                  sessionDurations: [
                    { agentId: 'codex', durationMs: 60000 },
                    { agentId: 'codex', durationMs: 120000 },
                  ],
                }
              : {}),
          },
        }),
        appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
        layout: {
          v: 1,
          items: [
            {
              kind: 'widget',
              id: 'records',
              title: 'Records this period',
              size: 'wide',
              frameStyle: 'plain',
              presentation: {
                kind: 'usage',
                widgetId: 'usage_recap',
                inputs: { style: 'personalRecords' },
              },
            },
          ],
        },
      });
      if (!view) throw new Error('expected a published view');
      const mounted = mountThroughReactNativeWeb(
        createElement(HappierUiEnvironmentProvider, {
          environment: projectHappierUiEnvironment(createSurfaceContext()),
          children: createElement(HappierPublicProfile, {
            view,
            labels,
            usage: {
              paint: { accent: '#007aff', paper: '#ffffff', dark: false },
              agent: (id) => ({ id, name: id, color: '#007aff' }),
              labels: {
                chartLabel: () => 'Period records',
                unavailable: 'Records not recorded',
                records: {
                  format: (kind: string, value: number) => ({
                    title: kind,
                    detail: 'In this period',
                    value: String(value),
                  }),
                  caption: 'Observed during the shared period',
                },
              },
            },
          }),
        }),
      );
      try {
        const block = mounted.container.querySelector(
          '[data-testid="public-profile-block-records"]',
        );
        if (recorded) {
          expect(block?.textContent).toContain(
            'currentStreakDaysIn this period3',
          );
          expect(block?.textContent).toContain(
            'longestTurnMsIn this period120000',
          );
          expect(block?.textContent).toContain(
            'Observed during the shared period',
          );
        } else {
          expect(block?.textContent).toContain('Records not recorded');
          expect(block?.textContent).not.toContain('longestTurnMs');
        }
        expect(block?.textContent).not.toContain('activeDays');
        expect(block?.textContent).not.toContain('bestStreakDays');
        expect(block?.textContent).not.toContain('peakParallel');
        expect(block?.textContent).not.toContain('9876');
      } finally {
        mounted.unmount();
      }
    },
  );
  it.each([
    { peak: 0, selected: true, state: 'known' },
    { peak: undefined, selected: true, state: 'missing' },
    { peak: 9876, selected: false, state: 'hidden' },
  ] as const)(
    'renders the shared period peak body without fabricating a day ($state)',
    ({ peak, selected, state }) => {
      const view = projectPublicProfile({
        context,
        policy: {
          ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
          fields: {
            ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
            peakParallel: selected,
          },
        },
        metadata: {},
        snapshot: PublicProfileSnapshotV1Schema.parse({
          ...snapshot,
          facts: peak === undefined ? {} : { peakParallel: peak },
        }),
        appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
        layout: {
          v: 1,
          items: [
            {
              kind: 'widget',
              id: 'parallel',
              title: 'At once',
              size: 'medium',
              frameStyle: 'plain',
              presentation: {
                kind: 'usage',
                widgetId: 'usage_parallel',
                inputs: { style: 'peak' },
              },
            },
          ],
        },
      });
      if (!view) throw new Error('expected a published view');
      const parallel: UsageDayLabels = {
        unknownAgent: 'Unknown agent',
        peakOnlyCaption:
          'The witnessed peak for this period; no timeline is shared.',
        clock: (hour) => `${hour}:00`,
        duration: (ms) => `${ms} ms`,
        atOnce: 'At once',
        turns: 'Turns',
        agentTime: 'Agent time',
        peak: (count, hour) => `${count} at once at ${hour}:00`,
        peakCount: (count) => `${count} at once`,
        peakLine: (hour, agents) =>
          `${hour}:00 ${agents.map((agent) => agent.name).join(', ')}`,
        waiting: 'Waiting for you',
        caption: { lanes: 'Day lanes', dial: 'Day dial' },
        values: {
          show: 'Show values',
          hide: 'Hide values',
          agentColumn: 'Agent',
          agentTimeColumn: 'Agent time',
          spansColumn: 'Spans',
          formatSpan: (from, to) => `${from}:00–${to}:00`,
        },
      };
      const mounted = mountThroughReactNativeWeb(
        createElement(HappierUiEnvironmentProvider, {
          environment: projectHappierUiEnvironment(createSurfaceContext()),
          children: createElement(HappierPublicProfile, {
            view,
            labels,
            usage: {
              paint: { accent: '#007aff', paper: '#ffffff', dark: false },
              agent: (id) => ({ id, name: id, color: '#007aff' }),
              labels: {
                chartLabel: () => 'Period peak',
                unavailable: 'Peak not recorded',
                parallel,
              },
            },
          }),
        }),
      );
      try {
        const block = mounted.container.querySelector(
          '[data-testid="public-profile-block-parallel"]',
        );
        if (state === 'known') {
          expect(block?.textContent).toContain('0 at once');
          expect(block?.textContent).toContain(parallel.peakOnlyCaption);
          expect(block?.querySelector('svg')).toBeNull();
          expect(block?.textContent).not.toContain('Day lanes');
          expect(block?.textContent).not.toContain('Waiting for you');
        } else if (state === 'missing') {
          expect(block?.textContent).toContain('Peak not recorded');
          expect(block?.textContent).not.toContain('0 at once');
        } else expect(block).toBeNull();
        expect(mounted.container.textContent).not.toContain('9876');
      } finally {
        mounted.unmount();
      }
    },
  );
  it.each([false, true])(
    'reserves the atmosphere band, lays the identity over its edge and credits the picture (phone: %s)',
    (singleColumn) => {
      const view = projectPublicProfile({
        context,
        policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1,
        metadata: {},
        snapshot,
        appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
        layout: { v: 1, items: [] },
      });
      if (!view) throw new Error('expected a published view');
      const seen: { bandHeightPx: number; singleColumn: boolean }[] = [];
      const mounted = mountThroughReactNativeWeb(
        createElement(HappierUiEnvironmentProvider, {
          environment: projectHappierUiEnvironment(createSurfaceContext()),
          children: createElement(HappierPublicProfile, {
            view,
            singleColumn,
            labels: {
              ...labels,
              heroCredit: 'White rocks, open sea · davide ragusa · Unsplash',
            },
            renderHero: (geometry) => {
              seen.push(geometry);
              return createElement('div', { 'data-testid': 'band-art' });
            },
          }),
        }),
      );
      try {
        const expected = singleColumn
          ? HAPPIER_PUBLIC_PROFILE_HERO_METRICS.bandHeightPx.phone
          : HAPPIER_PUBLIC_PROFILE_HERO_METRICS.bandHeightPx.wide;
        expect(seen.at(-1)).toEqual({ bandHeightPx: expected, singleColumn });
        const band = mounted.container.querySelector<HTMLElement>(
          '[data-testid="public-profile-hero-band"]',
        );
        // The band's height is known before any artwork paints, so nothing below it moves on arrival.
        expect(band?.style.height).toBe(`${expected}px`);
        expect(band?.querySelector('[data-testid="band-art"]')).not.toBeNull();
        expect(band?.textContent).toContain('White rocks, open sea');
        const hero = mounted.container.querySelector(
          '[data-testid="public-profile-hero"]',
        );
        expect(
          hero?.querySelector('[data-testid="public-profile-name"]')
            ?.textContent,
        ).toBe('Leeroy Brun');
      } finally {
        mounted.unmount();
      }
    },
  );

  it('marks the owner’s placed-but-private blocks as only theirs without changing the visitor tree', () => {
    const view = projectPublicProfile({
      context,
      policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      metadata: {},
      snapshot,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      layout: {
        v: 1,
        items: [
          metric('tokens', 'Tokens', 'tokens', 'medium'),
          metric('days', 'Active days', 'activeDays', 'medium'),
        ],
      },
    });
    if (!view) throw new Error('expected a published view');
    const mount = (owner?: {
      hiddenBlockIds: ReadonlySet<string>;
      onlyYou: string;
    }) =>
      mountThroughReactNativeWeb(
        createElement(HappierUiEnvironmentProvider, {
          environment: projectHappierUiEnvironment(createSurfaceContext()),
          children: createElement(HappierPublicProfile, {
            view,
            labels,
            ...(owner ? { owner } : {}),
          }),
        }),
      );
    const owned = mount({
      hiddenBlockIds: new Set(['tokens']),
      onlyYou: 'Only you',
    });
    try {
      const hidden = owned.container.querySelector(
        '[data-testid="public-profile-block-tokens"]',
      );
      expect(hidden?.textContent).toContain('Only you');
      expect(
        owned.container.querySelector(
          '[data-testid="public-profile-block-days"]',
        )?.textContent,
      ).not.toContain('Only you');
    } finally {
      owned.unmount();
    }
    const visitor = mount();
    try {
      expect(visitor.container.textContent).not.toContain('Only you');
    } finally {
      visitor.unmount();
    }
  });

  it('lets the owner edit the blocks in place while the header, period and footer stay the visitor page', () => {
    const view = projectPublicProfile({
      context,
      policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      metadata: {},
      snapshot,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      layout: {
        v: 1,
        items: [metric('days', 'Active days', 'activeDays', 'medium')],
      },
    });
    if (!view) throw new Error('expected a published view');
    const owned = mountThroughReactNativeWeb(
      createElement(HappierUiEnvironmentProvider, {
        environment: projectHappierUiEnvironment(createSurfaceContext()),
        children: createElement(HappierPublicProfile, {
          view,
          labels,
          owner: {
            hiddenBlockIds: new Set<string>(),
            onlyYou: 'Only you',
            renderBlocks: () =>
              createElement(
                'div',
                { 'data-testid': 'owner-area' },
                'Your editable area',
              ),
          },
        }),
      }),
    );
    try {
      expect(
        owned.container.querySelector('[data-testid="owner-area"]'),
      ).not.toBeNull();
      expect(
        owned.container.querySelector(
          '[data-testid="public-profile-block-days"]',
        ),
      ).toBeNull();
      expect(owned.container.textContent).toContain(labels.periodTitle);
      expect(owned.container.textContent).toContain(labels.footerNote);
    } finally {
      owned.unmount();
    }
  });

  it('draws the owner’s whole page before any Usage snapshot, with the customizing bar between the header and the period', () => {
    const owned = mountThroughReactNativeWeb(
      createElement(HappierUiEnvironmentProvider, {
        environment: projectHappierUiEnvironment(createSurfaceContext()),
        children: createElement(HappierPublicProfile, {
          view: {
            v: 1,
            handle: 'leeroy',
            indexable: false,
            state: 'published',
            identity: context.identity,
            metadata: {},
            snapshot: null,
            layout: { v: 1, items: [] },
            urls: context.urls,
          },
          labels,
          renderHero: () => createElement('div', { 'data-testid': 'band-art' }),
          owner: {
            hiddenBlockIds: new Set<string>(),
            onlyYou: 'Only you',
            renderToolbar: () =>
              createElement(
                'div',
                { 'data-testid': 'owner-toolbar' },
                'Customizing your profile',
              ),
            renderBlocks: () =>
              createElement(
                'div',
                { 'data-testid': 'owner-area' },
                'Your editable area',
              ),
          },
        }),
      }),
    );
    try {
      const text = owned.container.textContent ?? '';
      expect(
        owned.container.querySelector('[data-testid="public-profile-hero"]'),
      ).not.toBeNull();
      expect(
        owned.container.querySelector('[data-testid="owner-area"]'),
      ).not.toBeNull();
      expect(text).toContain('Leeroy Brun');
      expect(text.indexOf(labels.identityLine)).toBeLessThan(
        text.indexOf('Customizing your profile'),
      );
      expect(text.indexOf('Customizing your profile')).toBeLessThan(
        text.indexOf(labels.periodTitle),
      );
      expect(text).toContain(labels.footerNote);
    } finally {
      owned.unmount();
    }
  });

  it('keeps a name-only header with no band when the page has no atmosphere', () => {
    const view = projectPublicProfile({
      context,
      policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      metadata: {},
      snapshot,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      layout: { v: 1, items: [] },
    });
    if (!view) throw new Error('expected a published view');
    const mounted = mountThroughReactNativeWeb(
      createElement(HappierUiEnvironmentProvider, {
        environment: projectHappierUiEnvironment(createSurfaceContext()),
        children: createElement(HappierPublicProfile, { view, labels }),
      }),
    );
    try {
      expect(
        mounted.container.querySelector(
          '[data-testid="public-profile-hero-band"]',
        ),
      ).toBeNull();
      expect(
        mounted.container.querySelector('[data-testid="public-profile-name"]')
          ?.textContent,
      ).toBe('Leeroy Brun');
    } finally {
      mounted.unmount();
    }
  });

  it.each([true, false])(
    'renders a local picture preview without inventing a Report link (public destination: %s)',
    (configured) => {
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
      const appearance = PublicProfilePreparedAppearanceV1Schema.parse({
        theme: 'light',
        atmosphere: {
          source: 'picture',
          picture: {
            layout: 'horizon',
            descriptor: {
              kind: 'photo',
              title: 'Reviewed image',
              credit: null,
              adaptiveHaze: false,
              horizon: {},
              focus: {},
              hour: 0,
              grades: { light: 0, dusk: 0, night: 0 },
              dark: 'night',
              look: {
                effect: 'mosaic',
                params: {},
                strength: 0.37,
                dissolve: { style: 'rows', from: 0.58, to: 1 },
              },
            },
            content: { mimeType: 'image/png', base64: png },
          },
        },
      });
      const previewContext = configured
        ? context
        : { ...context, service: null, urls: null };
      const view = projectPublicProfilePreview({
        context: previewContext,
        policy: {
          ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
          fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false },
        },
        metadata: {},
        snapshot,
        appearance,
        layout: {
          v: 1,
          items: [
            metric('tokens', 'Tokens', 'tokens', 'medium'),
            metric('peak', 'At once', 'peakParallel', 'wide'),
          ],
        },
      });
      if (!view || view.appearance.atmosphere.source !== 'picture')
        throw new Error('expected a local picture preview');
      const picture = view.appearance.atmosphere.picture;
      const mounted = mountThroughReactNativeWeb(
        createElement(HappierUiEnvironmentProvider, {
          environment: projectHappierUiEnvironment(createSurfaceContext()),
          children: createElement(HappierPublicProfile, {
            view,
            labels,
            // The physical atmosphere renderer is a host boundary; this fixture observes the exact retained input.
            renderHero: () =>
              createElement('img', {
                alt: picture.descriptor.title,
                src: `data:${picture.content.mimeType};base64,${picture.content.base64}`,
                'data-testid': 'local-picture',
              }),
          }),
        }),
      );
      try {
        expect(
          mounted.container
            .querySelector('[data-testid="local-picture"]')
            ?.getAttribute('src'),
        ).toBe(`data:image/png;base64,${png}`);
        expect(
          mounted.container.querySelector(
            '[data-testid="public-profile-block-peak"]',
          )?.textContent,
        ).toContain('6');
        expect(
          mounted.container.querySelector(
            '[data-testid="public-profile-block-tokens"]',
          ),
        ).toBeNull();
        expect(mounted.container.textContent).not.toContain('87654321');
        expect(
          mounted.container
            .querySelector('[data-testid="public-profile-report"]')
            ?.getAttribute('href') ?? null,
        ).toBe(configured ? context.urls.report : null);
      } finally {
        mounted.unmount();
      }
    },
  );
  it.each([true, false])(
    'distinguishes selected missing calendar from hidden calendar (selected: %s)',
    (selected) => {
      const view = projectPublicProfile({
        context,
        policy: {
          ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
          fields: {
            ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
            calendar: selected,
          },
        },
        metadata: {},
        snapshot,
        appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
        layout: {
          v: 1,
          items: [
            {
              kind: 'widget',
              id: 'missing-sky',
              title: 'Shared sky',
              size: 'wide',
              frameStyle: 'plain',
              presentation: {
                kind: 'usage',
                widgetId: 'usage_rhythm',
                inputs: { style: 'sky' },
              },
            },
          ],
        },
      });
      if (!view) throw new Error('expected a published view');
      const mounted = mountThroughReactNativeWeb(
        createElement(HappierUiEnvironmentProvider, {
          environment: projectHappierUiEnvironment(createSurfaceContext()),
          children: createElement(HappierPublicProfile, {
            view,
            labels,
            usage: {
              paint: { accent: '#007aff', paper: '#ffffff', dark: false },
              agent: (id) => ({ id, name: id, color: '#007aff' }),
              labels: {
                chartLabel: () => 'Shared activity',
                unavailable: 'Activity not recorded',
              },
            },
          }),
        }),
      );
      try {
        const block = mounted.container.querySelector(
          '[data-testid="public-profile-block-missing-sky"]',
        );
        if (selected)
          expect(block?.textContent).toContain('Activity not recorded');
        else expect(block).toBeNull();
        expect(block?.textContent ?? '').not.toMatch(/\b0 days\b/u);
      } finally {
        mounted.unmount();
      }
    },
  );
  it('renders copied Usage bodies from the real projected view, with ordinal unknowns and share-only Agent rows', () => {
    const publicSnapshot = PublicProfileSnapshotV1Schema.parse({
      ...snapshot,
      period: {
        startMs: Date.UTC(2026, 8, 1),
        endMs: Date.UTC(2026, 8, 8),
        timeZoneOffsetMinutes: 0,
      },
      facts: {
        ...snapshot.facts,
        calendar: [
          { date: '2026-09-01', level: 4 },
          { date: '2026-09-02', level: null },
          { date: '2026-09-03', level: 0 },
        ],
        agentMix: [
          { agentId: 'codex', share: 0.75, tokens: 87654321, coverage },
          {
            agentId: 'claude',
            share: 0.25,
            tokens: 12345678,
            coverage: { status: 'unknown', method: 'context_only' },
          },
        ],
      },
    });
    const view = projectPublicProfile({
      context,
      policy: {
        ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
        fields: {
          ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields,
          tokens: false,
          calendar: true,
          agentMix: true,
        },
      },
      metadata: {},
      snapshot: publicSnapshot,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      layout: {
        v: 1,
        items: [
          {
            kind: 'widget',
            id: 'sky',
            title: 'Shared sky',
            size: 'wide',
            frameStyle: 'plain',
            presentation: {
              kind: 'usage',
              widgetId: 'usage_rhythm',
              inputs: { style: 'sky' },
            },
          },
          {
            kind: 'group',
            id: 'agents',
            width: 'full',
            frameStyle: 'plain',
            dividers: 'none',
            children: [
              {
                kind: 'widget',
                id: 'crew',
                title: 'Agent shares',
                size: 'medium',
                frameStyle: 'plain',
                presentation: {
                  kind: 'usage',
                  widgetId: 'usage_breakdowns',
                  inputs: { style: 'crew' },
                },
              },
            ],
          },
        ],
      },
    });
    if (!view) throw new Error('expected a published view');
    const usage = {
      paint: { accent: '#007aff', paper: '#ffffff', dark: false },
      cold: true,
      agent: (id: string) => ({
        id,
        name: id === 'codex' ? 'Codex' : 'Claude Code',
        color: '#007aff',
      }),
      labels: {
        chartLabel: () => 'Shared activity',
        unavailable: 'Not recorded',
        crew: {
          percent: (share: number) => `${share * 100}%`,
          days: (days: number) => `${days} days`,
        },
        sky: {
          formatValue: (value: number) => `PRIVATE AMOUNT ${value}`,
          month: (date: string) => date,
          day: (date: string) => date,
          levels: {
            quiet: 'Quiet',
            steady: 'Steady',
            busy: 'Busy',
            busiest: 'Busiest',
          },
          streakBestOngoing: (days: number) => `Best ongoing ${days}`,
          streakBest: (days: number) => `Best ${days}`,
          streakNow: (days: number) => `Current ${days}`,
          streakShort: (days: number) => `${days} days`,
          key: {
            tie: 'Tie',
            notAttributed: 'Not attributed',
            noActivity: 'No activity',
            notRecorded: 'Not recorded',
            quieter: 'Quieter',
            busier: 'Busier',
          },
          caption: () => 'Shared ordinal activity',
          values: {
            show: 'Show values',
            hide: 'Hide values',
            dateColumn: 'Day',
            valueColumn: 'Level',
            leaderColumn: 'Agent',
            noActivity: 'No activity',
            notRecorded: 'Not recorded',
            tie: 'Tie',
            notAttributed: 'Not attributed',
          },
        },
      },
    };
    const mounted = mountThroughReactNativeWeb(
      createElement(HappierUiEnvironmentProvider, {
        environment: projectHappierUiEnvironment(createSurfaceContext()),
        children: createElement(HappierPublicProfile, { view, labels, usage }),
      }),
    );
    try {
      expect(
        mounted.container.querySelector(
          '[data-testid="public-profile-usage-crew"]',
        )?.textContent,
      ).toContain('Codex');
      expect(mounted.container.textContent).toContain('75%');
      expect(mounted.container.textContent).not.toContain('25%');
      expect(mounted.container.textContent).not.toContain('PRIVATE AMOUNT');
      expect(mounted.container.textContent).not.toContain('87654321');
      const values = mounted.container.querySelector<HTMLElement>(
        '[data-testid="public-profile-usage-sky-values-toggle"]',
      );
      expect(values).not.toBeNull();
      act(() => values!.click());
      const sky = mounted.container.querySelector(
        '[data-testid="public-profile-usage-sky-values"]',
      )?.textContent;
      expect(sky).toContain('2026-09-01Busiest');
      expect(sky).toContain('2026-09-02Not recorded');
      expect(sky).toContain('2026-09-03No activity');
    } finally {
      mounted.unmount();
    }
  });
  it.each([
    { kind: 'unavailable' },
    { kind: 'paused', handle: 'ada', identity: { name: 'Ada Lovelace' } },
  ] as const)(
    'renders $kind without fabricating a published view or period',
    (input) => {
      const result = PublicProfileReadResultV1Schema.parse(input);
      if (result.kind === 'published')
        throw new Error('Expected a non-published result');
      const mounted = mountThroughReactNativeWeb(
        createElement(HappierUiEnvironmentProvider, {
          environment: projectHappierUiEnvironment(createSurfaceContext()),
          children: createElement(HappierPublicProfile, {
            result,
            labels: {
              paused: 'This profile is paused',
              unavailable: 'Profile unavailable',
            },
          }),
        }),
      );
      try {
        expect(mounted.container.textContent).toContain(
          input.kind === 'paused'
            ? 'This profile is paused'
            : 'Profile unavailable',
        );
        if (input.kind === 'paused')
          expect(mounted.container.textContent).toContain('Ada Lovelace');
        expect(mounted.container.textContent).not.toContain('Last 90 days');
        expect(mounted.container.textContent).not.toContain('87,654,321');
        expect(
          mounted.container.querySelector(
            '[data-testid="public-profile-block-tokens"]',
          ),
        ).toBeNull();
      } finally {
        mounted.unmount();
      }
    },
  );
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
  it('draws Sky of days without measurement on a cold host, at a width the page column gives a wide row and a half', () => {
    const publicSnapshot = PublicProfileSnapshotV1Schema.parse({
      ...snapshot,
      period: { startMs: Date.UTC(2026, 8, 1), endMs: Date.UTC(2026, 8, 8), timeZoneOffsetMinutes: 0 },
      facts: { ...snapshot.facts, calendar: [{ date: '2026-09-01', level: 4 }, { date: '2026-09-02', level: 2 }] },
    });
    const sky = (id: string, size: 'wide' | 'medium') => ({ kind: 'widget' as const, id, title: id, size, frameStyle: 'card' as const,
      presentation: { kind: 'usage' as const, widgetId: 'usage_rhythm' as const, inputs: { style: 'sky' } } });
    const view = projectPublicProfile({
      context,
      policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, calendar: true } },
      metadata: {},
      snapshot: publicSnapshot,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      layout: { v: 1, items: [sky('row', 'wide'), sky('left', 'medium'), sky('right', 'medium')] },
    });
    if (!view) throw new Error('expected a published view');
    const day = (date: string) => date;
    const usage = {
      paint: { accent: '#007aff', paper: '#ffffff', dark: false },
      cold: true,
      agent: (id: string) => ({ id, name: id, color: '#007aff' }),
      labels: {
        chartLabel: () => 'Shared activity',
        unavailable: 'Not recorded',
        sky: {
          formatValue: String, month: day, day,
          levels: { quiet: 'Quiet', steady: 'Steady', busy: 'Busy', busiest: 'Busiest' },
          streakBestOngoing: String, streakBest: String, streakNow: String, streakShort: String,
          key: { tie: 'Tie', notAttributed: 'Not attributed', noActivity: 'No activity', notRecorded: 'Not recorded', quieter: 'Quieter', busier: 'Busier' },
          caption: () => 'Shared ordinal activity',
          values: { show: 'Show values', hide: 'Hide values', dateColumn: 'Day', valueColumn: 'Level', leaderColumn: 'Agent',
            noActivity: 'No activity', notRecorded: 'Not recorded', tie: 'Tie', notAttributed: 'Not attributed' },
        },
      },
    };
    const mounted = mountThroughReactNativeWeb(
      createElement(HappierUiEnvironmentProvider, {
        environment: projectHappierUiEnvironment(createSurfaceContext()),
        children: createElement(HappierPublicProfile, { view, labels, usage }),
      }),
    );
    try {
      const drawn = (id: string) => {
        const svg = mounted.container.querySelector(`[data-testid="public-profile-block-${id}"] svg[viewBox]`);
        expect(svg, id).not.toBeNull();
        return Number(svg!.getAttribute('viewBox')!.split(' ')[2]);
      };
      const row = drawn('row');
      const half = drawn('left');
      expect(drawn('right')).toBe(half);
      expect(half).toBeLessThan(row / 2 + 1);
      expect(row).toBeGreaterThan(half * 2 - 40);
    } finally {
      mounted.unmount();
    }
  });
});
