import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import {
  resolveUsagePageAggregation,
  type UsageQueryResultSlice,
} from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { renderScreen } from '@/dev/testkit';
import { UsageChartPending } from './UsageChartStyleBodies';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

describe('Usage chart bodies while activity is still being read', () => {
  it('reads while activity is outstanding even when accounting already answered partially', async () => {
    const query = normalizeUsageQuery({
      period: { relative: '7days' },
      granularity: 'day',
    });
    const base = resolveUsagePageAggregation({ queries: [query] }).results[0]!;
    const slice: UsageQueryResultSlice = {
      ...base,
      sources: [
        { source: 'accounting', status: 'partial', asOfMs: 1 },
        { source: 'how_you_work', status: 'pending' },
      ],
    };
    const screen = await renderScreen(
      <UsageChartPending
        slice={slice}
        testID="sky"
        title="Busy time isn't recorded"
        reason="later"
      />,
    );
    expect(screen.findByTestId('sky.loading')).not.toBeNull();
    expect(screen.findByTestId('sky.needsData')).toBeNull();
  });

  it('says the measure is not recorded once activity has answered', async () => {
    const query = normalizeUsageQuery({
      period: { relative: '7days' },
      granularity: 'day',
    });
    const base = resolveUsagePageAggregation({ queries: [query] }).results[0]!;
    const slice: UsageQueryResultSlice = {
      ...base,
      sources: [
        { source: 'accounting', status: 'partial', asOfMs: 1 },
        { source: 'how_you_work', status: 'available', asOfMs: 1 },
      ],
    };
    const screen = await renderScreen(
      <UsageChartPending
        slice={slice}
        testID="sky"
        title="Busy time isn't recorded"
        reason="later"
      />,
    );
    expect(screen.findByTestId('sky.needsData')).not.toBeNull();
    expect(screen.findByTestId('sky.loading')).toBeNull();
  });
});
