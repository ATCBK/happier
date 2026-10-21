import { describe, expect, it } from 'vitest';
import type { PublicProfileSnapshotV1 } from '@happier-dev/plugin-sdk';
import * as components from '../../../components/index.public.js';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { renderSurface, publicSnapshotTemplate } from '../../../../fixtures/external-authoring/src/usageChartsSurface.js';
import { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { PublicProfileLayoutV1Schema } from '@happier-dev/protocol/widgets/widgetPublicSnapshotV1';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfile } from '@happier-dev/protocol/account/projectPublicProfile';

const base: PublicProfileSnapshotV1 = {
  v: 1, computedAtMs: 1, period: { startMs: Date.UTC(2026, 8, 1), endMs: Date.UTC(2026, 8, 8), timeZoneOffsetMinutes: 0 },
  coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: {},
};

describe('public Usage chart producer', () => {
  it('admits the external inert template and renders only its policy-projected shared fact', async () => {
    const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: [{ kind: 'widget', id: 'external-copy', size: 'medium',
      title: 'An external block', frameStyle: 'card', presentation: publicSnapshotTemplate }] });
    const view = projectPublicProfile({ context: { handle: 'garden', identity: {}, service: { displayName: 'Garden service', publicBaseUrl: 'https://garden.example' },
      urls: { page: 'https://garden.example/@garden', json: 'https://garden.example/v1/public/profiles/garden', badgeBase: 'https://garden.example/@garden/badge',
        card: 'https://garden.example/@garden/card.svg', og: 'https://garden.example/@garden/og.png', report: 'mailto:operator@garden.example' } },
      snapshot: { ...base, facts: { activeDays: 2, tokens: 87654321 } }, metadata: {}, layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } } });
    if (!view) throw new Error('Expected admitted public edition');
    const fixture = await createPluginUiTestkit({ identity: { instanceId: 'public-template', mountNonce: 'public-template' },
      surface: defineUiSurface(() => <components.HappierPublicProfile view={view} labels={{ identityLine: 'Garden service', periodTitle: 'This week',
        periodDetail: 'Shared facts', emptyLayout: 'No blocks', footerNote: 'Synced, not certified', report: 'Report', madeWith: 'Made with Happier',
        inert: { success: 'Success', warning: 'Warning', error: 'Error', incomplete: 'More' } }} />),
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }), adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { executeAction: async () => null } });
    try {
      expect(document.querySelector('[data-testid="public-profile-block-external-copy"]')?.textContent).toBe('An external block2');
      expect(document.body.textContent).not.toContain('87654321');
      expect(JSON.stringify(view)).not.toContain('87654321');
    } finally { await fixture.dispose(); }
  });
  it('mounts an external unrelated dataset through public components and discloses its actual values', async () => {
    const fixture = await createPluginUiTestkit({ identity: { instanceId: 'harvest', mountNonce: 'harvest' },
      surface: renderSurface, surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { executeAction: async () => null } });
    try {
      expect(document.querySelector('[data-testid="external-harvest"]')?.textContent).toContain('Tomatoes');
      const button = document.querySelector<HTMLElement>('[data-testid="external-harvest-hours-values-toggle"]')!;
      act(() => button.click());
      const values = document.querySelector('[data-testid="external-harvest-hours-values"]')?.textContent;
      expect(values).toContain('42 vegetables');
      expect(values).toContain('—');
      expect(values).not.toContain('tokens');
    } finally { await fixture.dispose(); }
  });
  it('uses only shared ordinal facts, and does not reconstruct hidden streak or width denominators', () => {
    const models = components.projectPublicUsageChartModels({ ...base, facts: {
      currentStreakDays: 3, calendar: [{ date: '2026-09-01', level: 4 }, { date: '2026-09-02', level: null }, { date: '2026-09-03', level: 0 }],
      weeklyAgentMix: [{ startMs: base.period.startMs, endMs: base.period.endMs,
        mix: [{ agentId: 'codex', share: 0.75, coverage: { status: 'partial', method: 'runtime' } }] }],
    } });
    expect(models.sky).toEqual({ encoding: 'ordinal', colourBy: 'intensity', days: [
      { date: '2026-09-01', state: 'active', level: 4 }, { date: '2026-09-02', state: 'unknown' }, { date: '2026-09-03', state: 'inactive' },
    ], current: { days: 3 } });
    expect(models.portrait).toEqual({ streak: { current: 3, best: null } });
    expect(models.river).toMatchObject({ width: 'share', weeks: [{ total: null, shares: { codex: 0.75 } }] });
    expect(models.peak).toBeNull();
    expect(models.runLength).toBeNull();
  });

  it('retains measured zero, missing cells, context-only membership and anonymous duration multiplicity', () => {
    const models = components.projectPublicUsageChartModels({ ...base, facts: {
      peakParallel: 0, mergedPrs: 0,
      agentMix: [{ agentId: 'codex', share: 0.6, coverage: { status: 'partial', method: 'runtime' } },
        { agentId: 'claude', share: 0.4, coverage: { status: 'unknown', method: 'context_only' } }],
      punch: [{ weekday: 0, hour: 4, level: 3 }, { weekday: 1, hour: 4, level: null }],
      sessionDurations: [{ agentId: 'codex', durationMs: 10 }, { agentId: 'codex', durationMs: 10 }, { agentId: 'codex', durationMs: 70 }],
    } });
    expect(models.agentShares).toEqual([{ agentId: 'codex', share: 0.6 }, { agentId: 'claude', share: null }]);
    expect(models.constellation).toEqual({ nodes: models.agentShares, edges: null, unknownStarts: null });
    expect(models.weekHours?.grid[6]?.[4]).toBe(3);
    expect(models.weekHours?.grid[0]?.[4]).toBeNull();
    expect(models.weekHours?.grid[0]?.[5]).toBeNull();
    expect(models.shipped).toEqual({ mode: 'count', total: 0 });
    expect(models.peak).toBe(0);
    expect(models.runLength).toEqual({ openCount: null, croppedCount: null, rows: [
      { agentId: 'codex', samples: 3, durationsMs: [10, 10, 70], medianMs: 10, p90Ms: 70 },
    ] });
  });

  it('does not infer per-hour activity or a streak from separately shared aggregate totals', () => {
    const models = components.projectPublicUsageChartModels({ ...base, facts: { tokens: 999999, activeDays: 4,
      bestStreakDays: 12, dayNightActivity: { window: { startHour: 22, endHour: 6 }, dayShare: 0.75, nightShare: 0.25,
        coverage: { status: 'partial', method: 'runtime' } } } });
    expect(models.sky).toBeNull();
    expect(models.weekHours).toBeNull();
    expect(models.daylight).toEqual({ encoding: 'ordinal', hours: Array(24).fill(null), night: { fromHour: 22, toHour: 6, share: 0.25 } });
    expect(models.portrait.streak).toBeUndefined();
    expect(models.agentShares).toBeNull();
    expect(models.river).toBeNull();
  });

  it('keeps independently shared Agent active days when Agent mix itself is off', () => {
    const models = components.projectPublicUsageChartModels({ ...base, facts: { agentActiveDays: [
      { agentId: 'codex', days: 2, coverage: { status: 'partial', method: 'runtime' } },
    ] } });
    expect(models.agentShares).toEqual([{ agentId: 'codex', share: null, activeDays: 2 }]);
  });

  it('formats public Personal records from the independently shared scalars, without private record positions', () => {
    const records = components.projectPublicUsageRecords({ ...base, facts: { activeDays: 2, currentStreakDays: 1,
      sessionDurations: [{ agentId: 'codex', durationMs: 20 }, { agentId: 'claude', durationMs: 60 }] } },
    (kind, value) => ({ title: kind, detail: 'Within the shared period', value: String(value) }));
    expect(records).toEqual([
      { id: 'activeDays', title: 'activeDays', detail: 'Within the shared period', value: '2' },
      { id: 'currentStreakDays', title: 'currentStreakDays', detail: 'Within the shared period', value: '1' },
      { id: 'longestTurnMs', title: 'longestTurnMs', detail: 'Within the shared period', value: '60' },
    ]);
  });
});
