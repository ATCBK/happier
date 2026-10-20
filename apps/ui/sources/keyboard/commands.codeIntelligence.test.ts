import { describe, expect, it } from 'vitest';
import { createKeyboardShortcutDispatcher } from './runtime';
import type { KeyboardSurface, KeyboardWebHost, NormalizedKeyboardEvent } from './types';

describe('fallback code navigation commands', () => {
    it.each([
        ['web', 'browser'], ['web', 'desktop'], ['native', undefined],
    ] satisfies Array<[KeyboardSurface, KeyboardWebHost | undefined]>)('routes definition and text references in editable code on %s/%s', (surface, webHost) => {
        const calls: string[] = [];
        const dispatch = createKeyboardShortcutDispatcher({
            enabled: true, platform: 'macos', surface, webHost, singleKeyShortcutsEnabled: false,
            disabledCommandIds: [], overrides: {},
            handlers: { 'code.goToDefinition': () => { calls.push('definition'); }, 'code.findReferences': () => { calls.push('references'); } },
            getContext: () => ({ isEditableTarget: true, isComposing: false }),
        });
        const event: NormalizedKeyboardEvent = { key: 'F12', code: 'F12', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false };
        expect(dispatch(event)).toBe(true);
        expect(dispatch({ ...event, shiftKey: true })).toBe(true);
        expect(calls).toEqual(['definition', 'references']);
        expect(dispatch({ ...event, isComposing: true })).toBe(false);
    });
});
