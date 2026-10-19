import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalPendingNotice } from '@happier-dev/plugin-ui/components';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function mount(
  node: React.ReactNode,
  translations?: Readonly<Record<string, string>>,
) {
  const context = createSurfaceContext(translations ? { translations } : undefined);
  return mountThroughReactNativeWeb(
    <PluginUiProvider
      hostApi={createHostApiStub(context)}
      context={context}
    >
      {node}
    </PluginUiProvider>,
  );
}

describe('public ApprovalPendingNotice', () => {
  it('banner says that the request waits, what finishes, and opens the approval through the author', () => {
    const onOpen = vi.fn();
    const mounted = mount(
      <ApprovalPendingNotice
        testID="notice"
        description="Approve the request to finish adding DeepSeek."
        onOpen={onOpen}
      />,
    );
    try {
      const notice = mounted.container.querySelector('[data-testid="notice"]');
      expect(notice?.textContent).toContain('Waiting for approval');
      expect(notice?.textContent).toContain(
        'Approve the request to finish adding DeepSeek.',
      );
      // Waiting on someone is announced politely, never as an alert.
      expect(notice?.getAttribute('role')).not.toBe('alert');
      act(() =>
        mounted.container
          .querySelector<HTMLElement>('[data-testid="notice.open"]')!
          .click(),
      );
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it('line names the waiting subject before the status and keeps one icon-only open control', () => {
    const onOpen = vi.fn();
    const mounted = mount(
      <ApprovalPendingNotice
        testID="line"
        presentation="line"
        subject="DeepSeek V4 Pro"
        onOpen={onOpen}
      />,
      { 'happier.plugin-ui.approvalPending.open': 'Open the approval' },
    );
    try {
      const line = mounted.container.querySelector('[data-testid="line"]');
      expect(
        mounted.container.querySelector('[data-testid="line.subject"]')
          ?.textContent,
      ).toBe('DeepSeek V4 Pro');
      expect(line?.textContent).toMatch(/DeepSeek V4 Pro\s*·\s*Waiting for approval/);
      expect(line?.textContent?.indexOf('DeepSeek V4 Pro')).toBeLessThan(
        line?.textContent?.indexOf('Waiting') ?? -1,
      );
      const open = mounted.container.querySelector<HTMLElement>(
        '[data-testid="line.open"]',
      )!;
      expect(open.getAttribute('aria-label')).toBe('Open the approval');
      act(() => open.click());
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });
});
