// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';

import type { TriageListItemV1 } from './sections.js';
import { useTriageListAnatomyV1 } from './rows.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

async function readAnatomy(input: Readonly<{ withSignal: boolean; withAgent: boolean }>) {
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
  });
});
