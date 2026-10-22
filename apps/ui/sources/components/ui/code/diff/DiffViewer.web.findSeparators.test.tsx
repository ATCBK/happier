// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';

// The renderer choice and its rows need the actual RNW DOM boundary.
vi.mock('react-native', async () => await import('react-native-web'));

const { DiffViewer } = await import('./DiffViewer.web');
const PATCH = [
  '@@ -18,3 +19,4 @@ export function SettingsModal()',
  '   const { width } = useWindowDimensions();',
  '-  const key = `${route.path}:${width}`;',
  '+  const key = useSettingsRouteKey(route);',
  '+  // keyed by route',
  '   return (',
  '',
].join('\n');
const initial = storage.getState().settings;

describe("DiffViewer while Find holds the Pierre renderer's place", () => {
  afterEach(() => {
    storage.setState({ settings: initial });
  });

  it('keeps the quiet unchanged-lines band instead of switching to the raw @@ header', async () => {
    storage.setState({
      settings: { ...initial, filesDiffRendererMode: 'pierre' },
    });
    const precomputedLines = buildCodeLinesFromUnifiedDiff({
      unifiedDiff: PATCH,
      hideFilePrelude: true,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <DiffViewer
            mode="unified"
            unifiedDiff={PATCH}
            findActive
            precomputedLines={precomputedLines}
            findRangesByLineId={new Map()}
          />,
        );
      });
      expect(container.textContent).toContain(
        'export function SettingsModal()',
      );
      expect(container.textContent).not.toContain('@@ -18,3 +19,4 @@');
      expect(container.textContent).toContain('useSettingsRouteKey(route)');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
