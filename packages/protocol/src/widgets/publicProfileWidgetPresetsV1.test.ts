import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '../account/publicProfile.js';
import { projectPublicProfile, validatePublicProfileLayout } from '../account/projectPublicProfile.js';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '../account/publicProfilePublication.js';
import { createPublicProfilePresetLayoutV1, PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1 } from './publicProfileWidgetPresetsV1.js';
import { resolveHostWidgetAreaPresetsV1 } from './widgetSurfaceArtifactV1.js';
import { WidgetAreaPresetV1Schema } from './widgetSurfaceArtifactV1.js';

const coverage = { status: 'complete_for_supplied_facts', method: 'runtime' } as const;
const snapshot = PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 10, coverage, fieldCoverage: {},
  period: { startMs: Date.UTC(2026, 6, 8), endMs: Date.UTC(2026, 9, 6), timeZoneOffsetMinutes: 0 },
  facts: { activeDays: 3, peakParallel: 2, calendar: [{ date: '2026-07-08', level: 2 }],
    agentMix: [{ agentId: 'codex', share: 1, coverage }] } });
const context = { handle: 'leeroy', identity: { name: 'Leeroy' }, service: { displayName: 'Happier Cloud', publicBaseUrl: 'https://happier.dev' },
  urls: { page: 'https://happier.dev/@leeroy', json: 'https://happier.dev/v1/public/profiles/leeroy', badgeBase: 'https://happier.dev/@leeroy/badge',
    card: 'https://happier.dev/@leeroy/card.svg', og: 'https://happier.dev/@leeroy/og.png', report: 'mailto:ops@happier.dev' } };

describe('public profile layout presets', () => {
  it('offers the same compositions as private core-page area defaults, with public presentation inputs only', () => {
    const presets = resolveHostWidgetAreaPresetsV1({ serverId: 'home', accountId: 'owner',
      owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } });
    expect(presets?.map(preset => preset.id)).toEqual(PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1);
    for (const preset of presets ?? []) {
      const parsed = WidgetAreaPresetV1Schema.parse(preset);
      const expected = createPublicProfilePresetLayoutV1(preset.id as typeof PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1[number], { title: () => undefined });
      expect(parsed.items.map(item => item.kind === 'widget' ? { id: item.instance.id, size: item.size,
        definition: item.instance.definition, bindings: item.instance.bindings } : null)).toEqual(expected.items.map(item => {
        if (item.kind !== 'widget' || item.presentation.kind !== 'usage') throw new Error('Expected builtin preset');
        return { id: item.id, size: item.size, definition: { kind: 'builtin', id: item.presentation.widgetId },
          bindings: Object.fromEntries(Object.entries(item.presentation.inputs).map(([key, value]) => [key, { kind: 'value', value }])) };
      }));
    }
  });

  it.each(PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1)('%s is a valid copied layout whose every block survives the default consent', id => {
    const layout = validatePublicProfileLayout(createPublicProfilePresetLayoutV1(id, { title: presentation => `title:${presentation.widgetId}` }));
    expect(layout.items.length).toBeGreaterThan(0);
    const view = projectPublicProfile({ context, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, snapshot, layout,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 });
    const shown = view?.layout.items.flatMap(item => item.kind === 'widget' ? [item.id] : item.children.map(child => child.id)) ?? [];
    const placed = layout.items.flatMap(item => item.kind === 'widget' ? [item.id] : item.children.map(child => child.id));
    expect(shown).toEqual(placed);
  });

  it('gives every preset at most three planet-art blocks and takes titles from the host', () => {
    for (const id of PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1) {
      const layout = createPublicProfilePresetLayoutV1(id, { title: presentation => `title:${presentation.widgetId}` });
      const widgets = layout.items.flatMap(item => item.kind === 'widget' ? [item] : item.children);
      const art = widgets.filter(widget => widget.presentation.kind === 'usage'
        && ['usage_planet', 'usage_orbit', 'usage_constellation'].includes(widget.presentation.widgetId));
      expect(art.length).toBeLessThanOrEqual(3);
      for (const widget of widgets) expect(widget.title).toMatch(/^title:usage_/u);
    }
  });
});
