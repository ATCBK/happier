import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { UsageSkyOfDays, type UsageSkyLabels, type UsageSkyModel } from './UsageSkyOfDays.js';

const query = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const labels: UsageSkyLabels = {
  formatValue: (value) => `${value} min`, month: (date) => date.slice(5, 7), day: (date) => date,
  levels: { quiet: 'Quiet', steady: 'Steady', busy: 'Busy', busiest: 'Busiest' },
  streakBestOngoing: (days) => `${days}-day streak, still going`, streakBest: (days) => `Best ${days}`, streakNow: (days) => `Now ${days}`,
  streakShort: (days) => `${days}-day streak`,
  key: { tie: 'Tie', notAttributed: 'Not attributed', noActivity: 'No activity', notRecorded: 'Not recorded', quieter: 'Quieter', busier: 'Busier' },
  caption: 'How to read it',
  values: { show: 'Exact values', hide: 'Hide values', dateColumn: 'Day', valueColumn: 'Busy time', leaderColumn: 'Led by', noActivity: 'No activity',
    notRecorded: 'Not recorded', tie: 'Tie', notAttributed: 'Not attributed' },
};
const agents = [{ id: 'claude', name: 'Claude Code', color: '#eb6834' }, { id: 'codex', name: 'Codex', color: '#2a78d6' }];
const paint = { accent: '#007aff', paper: '#ffffff', dark: false };

describe('Sky of days', () => {
  it('says each day exactly, keeps unknown apart from no activity, and names a tie by both Agents', () => {
    const model: UsageSkyModel = { encoding: 'amount', colourBy: 'leadingAgent', days: [
      { date: '2026-09-01', state: 'active', value: 90, leader: { kind: 'agent', agentId: 'claude' } },
      { date: '2026-09-02', state: 'active', value: 40, leader: { kind: 'tie', agentIds: ['claude', 'codex'] } },
      { date: '2026-09-03', state: 'inactive', value: 0 },
      { date: '2026-09-04', state: 'unknown' },
      { date: '2026-09-05', state: 'active', value: 10, leader: { kind: 'unknown' } },
    ] };
    const mount = mountThroughReactNativeWeb(<UsageSkyOfDays theme={SURFACE_CONTEXT_THEME_FIXTURE} paint={paint} agents={agents} model={model}
      labels={labels} label="Sky of days" width={640} testID="sky" />);
    try {
      const key = query(mount.container, 'sky-key')!.textContent;
      expect(key).toContain('Claude Code1');
      expect(key).toContain('Tie1');
      expect(key).toContain('Not attributed1');
      expect(key).toContain('No activity1');
      expect(key).toContain('Not recorded1');
      act(() => query(mount.container, 'sky-values-toggle')!.click());
      const values = query(mount.container, 'sky-values')!.textContent;
      expect(values).toContain('90 min');
      expect(values).toContain('Tie: Claude Code, Codex');
      // Unknown is not zero: the unrecorded day is never given an amount.
      expect(values).toContain('2026-09-04Not recorded');
      expect(values).not.toMatch(/2026-09-04\d/u);
    } finally { mount.unmount(); }
  });

  it('draws an ordinal (public) model as levels only, never an amount', () => {
    const model: UsageSkyModel = { encoding: 'ordinal', colourBy: 'intensity', days: [
      { date: '2026-09-01', state: 'active', level: 4 }, { date: '2026-09-02', state: 'active', level: 1 }, { date: '2026-09-03', state: 'inactive' },
    ] };
    const mount = mountThroughReactNativeWeb(<UsageSkyOfDays theme={SURFACE_CONTEXT_THEME_FIXTURE} paint={paint} agents={[]} model={model}
      labels={labels} label="Sky of days" width={640} testID="sky" />);
    try {
      expect(mount.container.textContent).not.toMatch(/\d+ min/u);
      expect(query(mount.container, 'sky-key')!.textContent).toContain('Busiest1');
      act(() => query(mount.container, 'sky-values-toggle')!.click());
      expect(query(mount.container, 'sky-values')!.textContent).toContain('2026-09-01Busiest');
    } finally { mount.unmount(); }
  });
});
