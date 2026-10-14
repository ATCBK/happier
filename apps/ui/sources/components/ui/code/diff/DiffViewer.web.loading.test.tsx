import * as React from 'react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } =
    await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({
    useSetting: (key: string) =>
      key === 'filesDiffRendererMode' ? 'pierre' : undefined,
  });
});

// The Pierre renderer is a lazily fetched chunk (network boundary): it never arrives in this suite,
// so the viewer stays in its loading state for the whole test.
vi.mock('./pierre/PierreDiffViewer.web', () => new Promise(() => {}));

vi.mock('./happier/HappierUnifiedDiffViewer', () => ({
  HappierUnifiedDiffViewer: (props: any) =>
    React.createElement('HappierUnifiedDiffViewer', {
      ...props,
      testID: 'happier-unified-diff-viewer',
    }),
}));

const DIFF =
  'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n';

describe('DiffViewer (web) while the Pierre renderer loads', () => {
  const previousWindow = (globalThis as any).window;
  const previousDocument = (globalThis as any).document;
  const previousWorker = (globalThis as any).Worker;

  beforeEach(() => {
    (globalThis as any).Worker = function Worker() {} as any;
    (globalThis as any).window = {};
    (globalThis as any).document = {
      baseURI: 'http://localhost/',
      createElement: () => ({ attachShadow: () => ({}) }),
    };
  });

  afterAll(() => {
    (globalThis as any).window = previousWindow;
    (globalThis as any).document = previousDocument;
    (globalThis as any).Worker = previousWorker;
  });

  it('shows the code itself, not an empty or loading body, for an inline unified diff', async () => {
    const { DiffViewer } = await import('./DiffViewer.web');

    const screen = await renderScreen(
      <DiffViewer
        mode="unified"
        unifiedDiff={DIFF}
        filePath="a.ts"
        showLineNumbers
        wrapLines={false}
      />,
    );

    const code = screen.findByTestId('happier-unified-diff-viewer');
    expect(code?.props.unifiedDiff).toBe(DIFF);
    expect(code?.props.showLineNumbers).toBe(true);
    expect(screen.findByTestId('pierre-diff-loading')).toBeNull();
  });

  it('keeps the pane loading state for a virtualized list diff', async () => {
    const { DiffViewer } = await import('./DiffViewer.web');

    const screen = await renderScreen(
      <DiffViewer
        mode="unified"
        unifiedDiff={DIFF}
        filePath="a.ts"
        virtualized
      />,
    );

    expect(screen.findByTestId('happier-unified-diff-viewer')).toBeNull();
  });
});
