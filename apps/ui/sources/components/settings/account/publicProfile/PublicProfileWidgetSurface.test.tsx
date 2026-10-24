import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { WidgetDefinitionV1Schema } from '@happier-dev/protocol/widgets';
import { describeAuthoredWidgetDefinitionV1 } from '@/components/widgets/widgetCatalog';
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
  it('admits 1000 duration facts once for twenty widgets and does no fact work on a Look/size edit', async () => {
    let visits = 0;
    const snapshot = PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 10,
      period: { startMs: 1, endMs: 9, timeZoneOffsetMinutes: 0 }, coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: {} });
    snapshot.facts.sessionDurations = Array.from({ length: 1000 }, () => ({ agentId: 'codex', get durationMs() { visits++; return 100; } }));
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'days', name: 'Days', sizeDeclaration: { sizes: ['medium', 'wide'], defaultSize: 'medium' },
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'private' } } },
      publicPresentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Duration',
        data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'activeDays'], type: 'number' } } } } });
    const descriptor = describeAuthoredWidgetDefinitionV1(definition, { kind: 'inline', definition });
    const source = { context: { handle: 'ada', identity: {}, service: null, urls: null }, snapshot, metadata: {},
      policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, sessionDurations: true } },
      appearance: { theme: 'auto' as const, atmosphere: { source: 'none' as const } } };
    const labels = { identityLine: '', periodTitle: '', periodDetail: '', emptyLayout: '', footerNote: '', report: '', madeWith: '',
      inert: { success: '', warning: '', error: '', incomplete: '' } };
    const tree = (size: 'medium' | 'wide') => <PublicProfileWidgetPreviewContext.Provider value={{ kind: 'ready', source, labels }}>
      {Array.from({ length: 20 }, (_, i) => <PublicProfileWidgetSurface key={i} instance={{ ...instance, id: String(i) }}
        descriptor={descriptor} size={size} testID={`block-${i}`} />)}
    </PublicProfileWidgetPreviewContext.Provider>;
    const screen = await renderScreen(tree('medium'));
    expect(visits).toBe(1000);
    visits = 0;
    await act(async () => { screen.update(tree('wide')); });
    expect(visits).toBe(0);
  });
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
