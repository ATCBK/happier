import { describe, expect, it } from 'vitest';

import {
  CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1,
  CurrentUiCommandDeclarationV1Schema,
  CurrentUiCommandDescriptorV1Schema,
  CurrentUiContextBoundedIncompletenessV1Schema,
  CurrentUiContextSnapshotV1Schema,
  PluginUiContextEnrichmentV1Schema,
} from './currentUiContext.js';
import { PluginUiHostMethodV1Schema } from './hostApiDefinition.js';
import { PluginUiPublishCurrentUiContextRequestV1Schema } from './hostApiRequests.js';
import {
  CurrentUiContextSnapshotV1Schema as RootCurrentUiContextSnapshotV1Schema,
  PluginUiContextEnrichmentV1Schema as RootPluginUiContextEnrichmentV1Schema,
} from '../../index.js';

describe('current UI context contract', () => {
  it('owns the strict explicit incompleteness marker', () => {
    expect(CurrentUiContextBoundedIncompletenessV1Schema.parse(
      CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1,
    )).toEqual({ incomplete: true });
    expect(CurrentUiContextBoundedIncompletenessV1Schema.safeParse({
      incomplete: true,
      extra: true,
    }).success).toBe(false);
  });

  it('publishes one closed enrichment and snapshot grammar', () => {
    const command = {
      title: 'Open review details',
      command: {
        kind: 'openSurface',
        destination: 'review-details',
        input: { tab: 'changes' },
      },
    } as const;
    const enrichment = {
      entity: {
        kind: 'review',
        label: 'PR #42',
        summary: 'Needs one approval',
        reference: { number: 42 },
      },
      detail: { tab: 'changes' },
      commands: [command],
    } as const;
    const snapshot = {
      navigation: {
        area: 'session',
        screen: 'review',
        title: 'PR #42',
        presentation: 'pane',
      },
      ...enrichment,
      commands: [{ id: 'command-1', title: 'Open review details' }],
    } as const;

    expect(PluginUiContextEnrichmentV1Schema.parse(enrichment)).toEqual(enrichment);
    expect(CurrentUiContextSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(CurrentUiCommandDeclarationV1Schema.parse(command)).toEqual(command);
    expect(CurrentUiCommandDescriptorV1Schema.parse(snapshot.commands[0])).toEqual(snapshot.commands[0]);
    expect(RootCurrentUiContextSnapshotV1Schema).toBe(CurrentUiContextSnapshotV1Schema);
    expect(RootPluginUiContextEnrichmentV1Schema).toBe(PluginUiContextEnrichmentV1Schema);
  });

  it('preserves complete command inventories through enrichment and descriptor snapshots', () => {
    const command = {
      title: 'Open review details',
      command: {
        kind: 'openSurface',
        destination: 'review-details',
      },
    } as const;

    const commands = Array.from({ length: 96 }, () => command);
    expect(PluginUiContextEnrichmentV1Schema.parse({ commands }).commands).toEqual(commands);
    const descriptors = commands.map((entry, index) => ({ id: `command-${index}`, title: entry.title }));
    expect(CurrentUiContextSnapshotV1Schema.parse({
      navigation: { area: 'settings', screen: 'usage' }, commands: descriptors,
    }).commands).toEqual(descriptors);
  });

  it('preserves strict context data independently of semantic launch-input budgets', () => {
    const enrichment = { entity: { kind: 'usage', label: 'Usage', reference: { keys: '€'.repeat(8_192) } },
      detail: { inventory: '€'.repeat(8_192) } };
    expect(PluginUiContextEnrichmentV1Schema.parse(enrichment)).toEqual(enrichment);
    expect(CurrentUiContextSnapshotV1Schema.parse({
      navigation: { area: 'settings', screen: 'usage' }, ...enrichment, commands: [],
    }).detail).toEqual(enrichment.detail);
  });

  it('rejects callbacks, unknown command kinds, and semantic payloads in opaque descriptors', () => {
    expect(PluginUiContextEnrichmentV1Schema.safeParse({
      detail: { render: () => undefined },
    }).success).toBe(false);
    expect(CurrentUiCommandDeclarationV1Schema.safeParse({
      title: 'Unknown',
      command: { kind: 'navigateAnywhere' },
    }).success).toBe(false);
    expect(CurrentUiCommandDescriptorV1Schema.safeParse({
      id: 'command-1',
      title: 'Open review details',
      command: { kind: 'openSurface', destination: 'review-details' },
    }).success).toBe(false);
  });

  it('admits one strict, mount-bound enrichment replacement request', () => {
    const enrichment = {
      entity: { kind: 'review', label: 'PR #42' },
      commands: [{
        title: 'Open review details',
        command: {
          kind: 'openSurface',
          destination: 'review-details',
          input: { tab: 'changes' },
        },
      }],
    } as const;

    expect(PluginUiHostMethodV1Schema.safeParse('publishCurrentUiContext').success).toBe(true);
    expect(PluginUiPublishCurrentUiContextRequestV1Schema.parse({ enrichment })).toEqual({ enrichment });
    expect(PluginUiPublishCurrentUiContextRequestV1Schema.parse({ enrichment: null })).toEqual({ enrichment: null });
    expect(PluginUiPublishCurrentUiContextRequestV1Schema.safeParse({
      enrichment,
      callback: () => undefined,
    }).success).toBe(false);
  });
});
