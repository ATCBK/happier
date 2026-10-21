import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, type PublicProfileLayoutV1, type PublicProfileOwnerRecordV1 } from '@happier-dev/protocol/account/publicProfilePublication';

import { createPublicProfileDraft, resolvePublicFieldPlacements, resolvePublicProfileDraftChanges, setPublicProfileDraftField } from './publicProfileDraft';

const coverage = { status: 'complete_for_supplied_facts', method: 'runtime' } as const;
const snapshot = PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 10, coverage, fieldCoverage: {},
  period: { startMs: Date.UTC(2026, 6, 8), endMs: Date.UTC(2026, 9, 6), timeZoneOffsetMinutes: 0 },
  facts: { activeDays: 3, calendar: [{ date: '2026-07-08', level: 2 }], agentMix: [{ agentId: 'codex', share: 1, coverage }], punch: [] } });
const context = { handle: 'leeroy', identity: { name: 'Leeroy' }, service: { displayName: 'Happier Cloud', publicBaseUrl: 'https://happier.dev' },
  urls: { page: 'https://happier.dev/@leeroy', json: 'https://happier.dev/v1/public/profiles/leeroy', badgeBase: 'https://happier.dev/@leeroy/badge',
    card: 'https://happier.dev/@leeroy/card.svg', og: 'https://happier.dev/@leeroy/og.png', report: 'mailto:ops@happier.dev' } };
const layout: PublicProfileLayoutV1 = { v: 1, items: [
  { kind: 'widget', id: 'days', size: 'full', frameStyle: 'plain', presentation: { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'sky' } } },
  { kind: 'widget', id: 'tide', size: 'medium', frameStyle: 'plain', presentation: { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'weekTide' } } },
] };
const record = (overrides: Partial<PublicProfileOwnerRecordV1> = {}): PublicProfileOwnerRecordV1 => ({
  state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [], query: null, snapshot,
  layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, updatedAtMs: 1, publishedAtMs: 1, restriction: null, ...overrides,
});

describe('public profile draft', () => {
  it('starts a first publication from the default consent, the given preset and a candidate planet look', () => {
    const draft = createPublicProfileDraft(null, { layout });
    expect(draft.policy).toEqual(DEFAULT_PUBLIC_PROFILE_POLICY_V1);
    expect(draft.layout).toBe(layout);
    expect(draft.appearance.kind).toBe('candidate');
    expect(resolvePublicProfileDraftChanges(null, draft)).toEqual({ policy: true, layout: true, appearance: true });
  });

  it('keeps the applied edition until a member actually changes, then names only that member', () => {
    const applied = record();
    const draft = createPublicProfileDraft(applied, { layout: { v: 1, items: [] } });
    expect(draft.layout).toEqual(layout);
    expect(draft.appearance).toEqual({ kind: 'applied' });
    expect(resolvePublicProfileDraftChanges(applied, draft)).toEqual({ policy: false, layout: false, appearance: false });
    const hidden = setPublicProfileDraftField(draft, 'calendar', false);
    expect(hidden.policy.fields.calendar).toBe(false);
    expect(draft.policy.fields.calendar).toBe(true);
    expect(resolvePublicProfileDraftChanges(applied, hidden)).toEqual({ policy: true, layout: false, appearance: false });
    expect(resolvePublicProfileDraftChanges(applied, setPublicProfileDraftField(hidden, 'calendar', true)).policy).toBe(false);
  });

  it('says which items show in blocks, are placed but private, or only reach badges and JSON', () => {
    const draft = createPublicProfileDraft(record(), { layout });
    const placements = resolvePublicFieldPlacements({ context, snapshot, draft });
    expect(placements.calendar).toEqual({ shown: true, blocks: 1 });
    // Hours of the week is placed (Week tide) but not shared: only the owner sees it.
    expect(placements.punch).toEqual({ shown: false, blocks: 1 });
    // Active days is shared but no placed block needs it: it reaches badges and JSON only.
    expect(placements.activeDays).toEqual({ shown: true, blocks: 0 });
    expect(placements.machineKinds).toEqual({ shown: false, blocks: 0 });
  });
});
