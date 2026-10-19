import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./BaseModal', () => ({
  BaseModal: (props: any) =>
    React.createElement('BaseModal', props, props.children),
}));

installModalComponentCommonModuleMocks();

afterEach(() => {
  vi.unstubAllGlobals();
});

function flattenStyle(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === 'function'
      ? style({ pressed: false, hovered: false, focused: false })
      : style;
  return Object.assign({}, ...[resolved].flat(Infinity).filter(Boolean));
}

async function renderOnPhoneBrowser(
  element: () => Promise<React.ReactElement>,
) {
  // The primary pointer is a browser boundary: a phone browser reports touch points and no hover.
  vi.stubGlobal('navigator', { maxTouchPoints: 5 });
  const { resolveMinimumInteractiveTargetSize } =
    await import('@/components/ui/interactiveTargetSize');
  return {
    screen: await renderScreen(await element()),
    floor: resolveMinimumInteractiveTargetSize('web'),
  };
}

describe('web alert and prompt actions under a finger', () => {
  it('give every alert choice the platform touch floor', async () => {
    const { screen, floor } = await renderOnPhoneBrowser(async () => {
      const { WebAlertModal } = await import('./WebAlertModal');
      return (
        <WebAlertModal
          config={{
            id: 'c',
            type: 'confirm',
            title: 'Discard changes?',
            cancelText: 'Keep editing',
            confirmText: 'Discard',
            destructive: true,
          }}
          onClose={() => {}}
          onConfirm={() => {}}
        />
      );
    });
    expect(floor).toBe(44);
    for (const testID of ['web-modal-cancel', 'web-modal-confirm']) {
      expect(
        flattenStyle(screen.findByTestId(testID)?.props.style).minHeight,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it('give prompt choices the touch floor and name the prompt field by the dialog title', async () => {
    const { screen, floor } = await renderOnPhoneBrowser(async () => {
      const { WebPromptModal } = await import('./WebPromptModal');
      return (
        <WebPromptModal
          config={{
            id: 'p',
            type: 'prompt',
            title: 'Rename branch',
            cancelText: 'Cancel',
            confirmText: 'Rename',
            defaultValue: 'main',
            inputType: 'default',
          }}
          onClose={() => {}}
          onConfirm={() => {}}
        />
      );
    });
    for (const testID of ['web-prompt-cancel', 'web-prompt-confirm']) {
      expect(
        flattenStyle(screen.findByTestId(testID)?.props.style).minHeight,
      ).toBeGreaterThanOrEqual(floor);
    }
    // The prompt's field is the shared page field: it is named for assistive technology.
    expect(
      screen.findByTestId('web-prompt-input')?.props.accessibilityLabel,
    ).toBe('Rename branch');
  });
});
