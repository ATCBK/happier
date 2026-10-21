import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PUBLIC_PROFILE_FIELDS_V1, type PublicProfileField } from '@happier-dev/protocol/account/publicProfile';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import type { PublicFieldPlacement } from './publicProfileDraft';
import { PublicProfilePublicData } from './PublicProfilePublicData';

const placements = Object.fromEntries(PUBLIC_PROFILE_FIELDS_V1.map(field => [field, { shown: DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields[field], blocks: 0 }])) as Record<PublicProfileField, PublicFieldPlacement>;

describe('PublicProfilePublicData', () => {
  it('offers one switch per item, reflecting and changing only that item’s consent', async () => {
    const onToggle = vi.fn();
    const screen = await renderScreen(<PublicProfilePublicData policy={DEFAULT_PUBLIC_PROFILE_POLICY_V1}
      placements={{ ...placements, calendar: { shown: true, blocks: 2 } }} onToggle={onToggle} />);
    for (const field of PUBLIC_PROFILE_FIELDS_V1) {
      expect(screen.findByTestId(`public-data-switch-${field}`)?.props.value).toBe(DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields[field]);
    }
    screen.findByTestId('public-data-switch-calendar')!.props.onValueChange(false);
    expect(onToggle).toHaveBeenCalledWith('calendar', false);
    expect(screen.getTextContent()).toContain(t('publicIdentity.publicData.blocks', { count: 2 }));
  });

  it('explains items that reach only badges and JSON, and private placed items', async () => {
    const screen = await renderScreen(<PublicProfilePublicData policy={DEFAULT_PUBLIC_PROFILE_POLICY_V1}
      placements={{ ...placements, activeDays: { shown: true, blocks: 0 }, punch: { shown: false, blocks: 1 } }} onToggle={() => {}} />);
    expect(screen.getTextContent()).toContain(t('publicIdentity.publicData.notPlaced'));
    expect(screen.getTextContent()).toContain(t('publicIdentity.publicData.placedPrivate'));
  });

  it('keeps weekly peaks unavailable while peak parallel is not shared, and says why', async () => {
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, peakParallel: false } };
    const screen = await renderScreen(<PublicProfilePublicData policy={policy} placements={placements} onToggle={() => {}} />);
    expect(screen.findByTestId('public-data-switch-weeklyPeakParallel')?.props.disabled).toBe(true);
    expect(screen.getTextContent()).toContain(t('publicIdentity.publicData.needsPeak'));
  });
});
