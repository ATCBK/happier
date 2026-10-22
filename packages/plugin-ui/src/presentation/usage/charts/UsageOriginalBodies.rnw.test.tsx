import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { UsageBreakdownsBody } from './UsageBreakdownsBody.js';
import { UsageOutcomesBody } from './UsageOutcomesBody.js';
import { UsageRecapBody } from './UsageRecapBody.js';

describe('original Usage bodies with reduced public models', () => {
  it('keeps private funnel values, financial basis and the real row interaction supplied by its adapter', () => {
    let opened = false;
    const mount = mountThroughReactNativeWeb(<UsageOutcomesBody theme={theme} testID="private"
      model={{ kind: 'work', funnel: { label: 'Linked work', total: 9, steps: [
        { id: 'sessions', label: 'Sessions', value: 9 }, { id: 'merged', label: 'Merged', value: 2 },
      ] }, groups: [{ id: 'reported', label: 'Pull requests', basis: 'Reported EUR', valueFormatter: value => `€${value}`,
        rows: [{ id: 'private-pr', label: 'Improve exports', value: 7, annotation: 'Merged in 2 days' }],
        renderRow: (row, visual) => <button aria-label={row.label} onClick={() => { opened = true; }}>{visual}</button>,
      }] }} />);
    try {
      expect(mount.container.textContent).toContain('Sessions');
      expect(mount.container.textContent).toContain('Reported EUR');
      expect(mount.container.textContent).toContain('€7');
      expect(mount.container.textContent).toContain('Merged in 2 days');
      act(() => mount.container.querySelector<HTMLButtonElement>('button[aria-label="Improve exports"]')!.click());
      expect(opened).toBe(true);
    } finally { mount.unmount(); }
  });
  it('renders independently admitted shares, including unknown membership, without inventing an amount', () => {
    const mount = mountThroughReactNativeWeb(<UsageBreakdownsBody theme={theme} testID="mix" model={{ blocks: [{ id: 'agent', label: 'Agents',
      total: 1, valueFormatter: value => `${value * 100}%`, unknownLabel: '—', rows: [
        { id: 'a', label: 'Garden agent', value: 0.6 }, { id: 'b', label: 'Context agent', value: null },
      ] }] }} />);
    try {
      expect(mount.container.textContent).toContain('60%');
      expect(mount.container.textContent).toContain('Context agent');
      expect(mount.container.textContent).toContain('—');
      expect(mount.container.textContent).not.toContain('tokens');
    } finally { mount.unmount(); }
  });
  it('renders only the shared merged count, preserving measured zero without fabricating a funnel or PR', () => {
    const mount = mountThroughReactNativeWeb(<UsageOutcomesBody theme={theme} testID="outcomes"
      model={{ kind: 'count', count: 0, label: 'Merged pull requests', formatValue: String }} />);
    try {
      expect(mount.container.textContent).toContain('Merged pull requests');
      expect(mount.container.textContent).toContain('0');
      expect(mount.container.querySelector('[data-testid="outcomes.funnel"]')).toBeNull();
      expect(mount.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    } finally { mount.unmount(); }
  });
  it('renders admitted recap facts without private query, story, or sharing controls', () => {
    const mount = mountThroughReactNativeWeb(<UsageRecapBody theme={theme} testID="recap" model={{ highlights: [
      { id: 'tokens', label: 'Tokens', value: '24K', detail: 'This period' },
    ] }} />);
    try {
      expect(mount.container.querySelector('[aria-label="Tokens: 24K, This period"]')).not.toBeNull();
      expect(mount.container.querySelector('[data-testid="recap.highlights"]')).not.toBeNull();
      expect(mount.container.querySelector('[data-testid="recap.actions"]')).toBeNull();
      expect(mount.container.querySelectorAll('button')).toHaveLength(0);
    } finally { mount.unmount(); }
  });
});
