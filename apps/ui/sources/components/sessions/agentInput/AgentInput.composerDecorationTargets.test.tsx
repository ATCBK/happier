import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { AgentInputComposerDecoration } from './agentInputContracts';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();
afterEach(async () => { (await import('react-native')).Platform.OS = 'web'; });

function flattenStyle(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (Array.isArray(value)) {
    return value.reduce<Record<string, unknown>>(
      (result, entry) => ({ ...result, ...flattenStyle(entry) }),
      {},
    );
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

const DECORATION_ID = 'acme.fixture:mounted-1:references';

const decorations = [{
  id: DECORATION_ID,
  key: 'references',
  decorations: {
    revision: 1,
    ranges: [
      {
        range: { start: 0, end: 5 },
        treatment: { kind: 'link' as const, url: 'https://example.com/first' },
        label: 'First reference',
      },
      {
        range: { start: 6, end: 12 },
        treatment: { kind: 'link' as const, url: 'https://example.com/second' },
        label: 'Second reference',
      },
      {
        range: { start: 13, end: 19 },
        treatment: 'warning' as const,
        label: 'Heads up',
      },
    ],
  },
}] satisfies readonly AgentInputComposerDecoration[];

async function renderComposerWithDecorations() {
  const { AgentInput } = await import('./AgentInput');
  return renderScreen(
    <AgentInput
      value="alpha bravo charlie"
      onChangeText={() => {}}
      placeholder="p"
      onSend={() => {}}
      autocompleteKinds={[]}
      autocompleteSuggestions={async () => []}
      disabled={false}
      showAbortButton={false}
      composerDecorations={decorations}
      composerInputLock={{ mode: 'editAndSubmit', reasons: ['Review required'] }}
    />,
    { wrapper: runtime.Wrapper },
  );
}

describe('AgentInput composer decoration interactive targets', () => {
  it('uses the Elements backing-dependent material for the real composer', async () => {
    const { AgentInput } = await import('./AgentInput');
    const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
    const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
    const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
    const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('clear') }}>
      <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper' }}>
        <AgentInput value="Keep this draft" onChangeText={() => {}} onSend={() => {}} placeholder="p" disabled={false} autocompleteKinds={[]} autocompleteSuggestions={async () => []} />
      </GlassRuntimeEnvironmentProvider>
    </GlassMaterialSettingsProvider>, { wrapper: runtime.Wrapper });
    // On web the surface itself is transparent: its material is the backdrop layer painted beneath the
    // content, and that layer reads the card material's published opacity (`glassDocumentPresentation`).
    const surface = screen.tree.findHostByTestId('agent-input-material-surface')!;
    const paint = surface.findAll((node) => typeof node.type === 'string' && node.props.dataSet?.happyGlassBackdrop === 'true')[0]!;
    expect(String(flattenStyle(paint.props.style).backgroundColor)).toContain('--happier-glass-card-opacity');
  });
  it.each(['web', 'ios', 'android'] as const)('places scoped decorations only in the %s input while preserving the input lock feedback', async (platform) => {
    const { Platform } = await import('react-native');
    Platform.OS = platform;
    const { MultiTextInput } = await import('@/components/ui/forms/MultiTextInput');
    const screen = await renderComposerWithDecorations();
    expect((await import('react-native')).Platform.OS).toBe(platform);
    const input = screen.findAll((node) => node.type === MultiTextInput)[0]!;
    expect(input.props.decorations).toEqual(decorations[0].decorations.ranges.map((entry) => ({
      ...entry.range, treatment: entry.treatment, label: entry.label,
    })));
    expect(screen.findAll((node) => typeof node.props.testID === 'string'
      && node.props.testID.startsWith('agent-input-composer-decoration:')).length).toBe(0);
    expect(input.props.editable).toBe(false);
    expect(screen.getTextContent()).toContain('Review required');
  });
});
