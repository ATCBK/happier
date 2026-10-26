import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '../lists/uiListsTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
installUiListsCommonModuleMocks();

afterEach(() => vi.unstubAllGlobals());

function flattenStyle(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === 'function'
      ? style({ pressed: false, hovered: false, focused: false })
      : style;
  return Object.assign({}, ...[resolved].flat(Infinity).filter(Boolean));
}

describe('InlineAddExpander actions', () => {
  it('are the shared button family: drawn at design size under a finger, a disabled Save that cannot be pressed', async () => {
    // The primary pointer is a browser boundary: a phone browser reports touch points and no hover.
    vi.stubGlobal('navigator', { maxTouchPoints: 5 });
    const { InlineAddExpander } = await import('./InlineAddExpander');
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const screen = await renderScreen(
      <InlineAddExpander
        isOpen
        onOpenChange={() => {}}
        title="Add variable"
        trigger={null}
        onSave={onSave}
        onCancel={onCancel}
        saveDisabled
        saveLabel="Save"
        cancelLabel="Cancel"
        saveTestID="add-save"
        cancelTestID="add-cancel"
      >
        {React.createElement('Text', null, 'Variable fields')}
      </InlineAddExpander>,
    );
    const save = screen.findByTestId('add-save')!;
    const cancel = screen.findByTestId('add-cancel')!;
    // A touch target is a hit area, not a drawn size: neither button is drawn at 44.
    expect(flattenStyle(save.props.style).minHeight).toBeUndefined();
    expect(flattenStyle(cancel.props.style).minHeight).toBeUndefined();
    expect(
      save.props.accessibilityState?.disabled ?? save.props['aria-disabled'],
    ).toBe(true);
    await act(async () => cancel.props.onPress?.());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });
});
