import { describe, expect, it } from 'vitest';
import { createKeyboardShortcutDispatcher } from './runtime';
import type { NormalizedKeyboardEvent } from './types';

describe('pane keyboard commands', () => {
  it('cycles regions with a function key even when single-character shortcuts are disabled', () => {
    let runs = 0;
    const dispatch = createKeyboardShortcutDispatcher({ enabled: true, platform: 'macos', surface: 'native', singleKeyShortcutsEnabled: false,
      disabledCommandIds: [], overrides: {}, handlers: { 'panes.region.next': () => { runs += 1; } }, getContext: () => ({ isEditableTarget: false, isComposing: false }) });
    expect(dispatch({ key: 'F6', code: 'F6', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false })).toBe(true);
    expect(runs).toBe(1);
  });
  it.each([
    ['shell.column.toggle', 'b', false, false],
    ['panes.main.toggle', 'b', true, false],
    ['panes.side.toggle', 'e', false, true],
    ['panes.arrangement.toggle', 'e', true, false],
  ] as const)('dispatches %s on desktop and yields while typing', (id, key, altKey, shiftKey) => {
    let runs = 0;
    let editable = false;
    const dispatch = createKeyboardShortcutDispatcher({ enabled: true, platform: 'macos', surface: 'native', singleKeyShortcutsEnabled: false,
      disabledCommandIds: [], overrides: {}, handlers: { [id]: () => { runs += 1; } }, getContext: () => ({ isEditableTarget: editable, isComposing: false }) });
    const event: NormalizedKeyboardEvent = { key, code: `Key${key.toUpperCase()}`, metaKey: true, ctrlKey: false, altKey, shiftKey, repeat: false, isComposing: false };
    expect(dispatch(event)).toBe(true);
    expect(runs).toBe(1);
    editable = true;
    expect(dispatch(event)).toBe(false);
    expect(runs).toBe(1);
  });
});
