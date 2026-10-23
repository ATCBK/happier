import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
  PublicProfileWidgetPreviewContext,
  PublicProfileWidgetSurface,
} from './PublicProfileWidgetSurface';

const instance = {
  v: 1 as const,
  id: 'sky',
  definition: { kind: 'artifact' as const, artifactId: 'sky-definition' },
  bindings: {},
};

describe('PublicProfileWidgetSurface', () => {
  it('keeps a placed block’s slot quiet while the page’s Usage is unavailable, without inventing a per-block cause', async () => {
    const reason = t('publicIdentity.profile.reasons.usage_unavailable');
    const screen = await renderScreen(
      <PublicProfileWidgetPreviewContext.Provider
        value={{ kind: 'unavailable', reason }}
      >
        <PublicProfileWidgetSurface
          instance={instance}
          descriptor={null}
          testID="block"
        />
      </PublicProfileWidgetPreviewContext.Provider>,
    );
    expect(screen.getTextContent()).not.toContain(
      t('publicIdentity.page.blockUnavailable'),
    );
    expect(
      screen.findByTestId('block.awaiting')?.props.accessibilityLabel,
    ).toBe(reason);
  });
});

describe('PublicProfileWidgetPreviewRead', () => {
  it('keeps a standalone setup’s controls while the page preview is preparing or cannot be prepared', async () => {
    const { PublicProfileWidgetPreviewRead } = await import('./PublicProfileWidgetSurface');
    const context = { handle: 'leeroy', identity: {}, service: null, urls: null };
    const execution = { ready: true, isCurrent: () => true, executeValue: async (actionId: string) => actionId === 'account.public_profile.get'
      ? { kind: 'absent', context } : { kind: 'unavailable', reason: 'usage_unavailable' } } as never;
    const screen = await renderScreen(
      <PublicProfileWidgetPreviewRead execution={execution} serverId="server">
        <Text testID="size-selector">Size</Text>
      </PublicProfileWidgetPreviewRead>,
    );
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(screen.findByTestId('size-selector')).not.toBeNull();
  });
});
