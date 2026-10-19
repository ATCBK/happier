// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';

import type { TriageListItemV1 } from './sections.js';
import { TRIAGE_ROW_REASON_TEST_ID_V1, useTriageListAnatomyV1 } from './rows.js';
import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

async function readAnatomy(input: Readonly<{ withSignal: boolean; withAgent: boolean; withReason?: boolean }>) {
  let anatomy: CollectionAnatomy<TriageListItemV1> | null = null;
  const surface = defineUiSurface(function Probe() {
    anatomy = useTriageListAnatomyV1(input);
    return <Text value="probe" />;
  });
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'triage-columns-test', mountNonce: 'triage-columns-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface, surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {},
    });
  });
  mounted.push(fixture);
  await expect(fixture.getByText('probe')).resolves.toBeDefined();
  return anatomy as unknown as CollectionAnatomy<TriageListItemV1>;
}

describe('PRs & Issues table columns', () => {
  it('draws the Agent column only when some listed entry has a linked agent, like Signal', async () => {
    const without = await readAnatomy({ withSignal: false, withAgent: false });
    expect(without.agent).toBeUndefined();
    expect(without.signal).toBeUndefined();
    const withBoth = await readAnatomy({ withSignal: true, withAgent: true });
    expect(withBoth.agent).toBeDefined();
    expect(withBoth.signal).toBeDefined();
    // Why it's here, too: when every reason is already said by its group's line, the column is not a wall of dashes.
    expect(withBoth.reason).toBeDefined();
    expect((await readAnatomy({ withSignal: true, withAgent: true, withReason: false })).reason).toBeUndefined();
  });

  it('draws a suggested reason as the same quiet chip with its mark that the detail header shows, not bare words', async () => {
    const row = {
      key: 'happier.forge/items|pull-request|origin|31',
      entryRef: { source: { pluginId: 'happier.forge', sourceId: 'items' }, kindId: 'pull-request', collisionScope: 'origin', entryId: '31' },
      title: 'Replace the duplicated normalizer', scopeLabel: 'example/repository',
      detail: 'Mentioned', tone: 'neutral', detailKind: 'suggestion', detailIcon: 'mention',
      authorLabel: null, designation: '#31', lifecyclePresentation: 'active', activityAtMs: null,
      pinned: false, materialized: true, sourceInstanceId: null, kindId: 'pull-request', lifecycleLabel: 'Open',
      observedAtMs: 1_000, stale: false,
    } as unknown as TriageListDisplayRowV1;
    const item: TriageListItemV1 = { key: row.key, row, group: 'everythingElse', summary: null, signal: null, agent: null };
    const surface = defineUiSurface(function Probe() {
      const anatomy = useTriageListAnatomyV1({ withSignal: false, withAgent: false });
      return <>{anatomy.reason?.(item)}</>;
    });
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'triage-reason-test', mountNonce: 'triage-reason-mount' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface, surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {},
      });
    });
    mounted.push(fixture);
    await expect(fixture.getByText('Mentioned')).resolves.toBeDefined();
    expect(document.querySelector(`[data-testid="${TRIAGE_ROW_REASON_TEST_ID_V1}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-testid="${TRIAGE_ROW_REASON_TEST_ID_V1}:icon"]`)).not.toBeNull();
  });
});
