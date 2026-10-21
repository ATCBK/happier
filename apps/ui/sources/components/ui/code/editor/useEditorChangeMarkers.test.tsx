/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import type { EditorDecoration, EditorDecorationLayer, TextEditorHandle } from './codeEditorTypes';
import { buildEditorChangeMarkers } from './editorChangeMarkers';
import { useEditorChangeMarkers } from './useEditorChangeMarkers';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
afterEach(standardCleanup);

describe('change marker admission', () => {
    it('publishes pending engine text before opening dirty actions and retires an outgoing flush', async () => {
        const marker = buildEditorChangeMarkers('a.ts', null, '@@ -1 +1 @@\n-old\n+saved\n')[0]!;
        const markers = [marker];
        let text = 'saved\n';
        let publishedText = text;
        let openedDirty: boolean | null = null;
        let active = true;
        let flush = createDeferred<void>();
        let press: ((layer: EditorDecorationLayer, item: EditorDecoration) => void) | undefined;
        // The real host receives text only when the engine flushes its existing debounce.
        const engine: TextEditorHandle = {
            getValue: () => text,
            flushPendingChange: async () => { await flush.promise; publishedText = text; },
            setDecorations: () => {},
            onDecorationPress: callback => { press = callback; return () => { press = undefined; }; },
        };
        let controller!: ReturnType<typeof useEditorChangeMarkers>;
        function Markers() {
            controller = useEditorChangeMarkers({ editor: engine, active, seedKey: 'saved-v1', markers });
            if (controller.selected) openedDirty = publishedText !== 'saved\n';
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Markers /></KeyboardShortcutProvider>);
        text = 'saved\nmy pending edit\n';
        await act(async () => { press?.('change', marker); });
        expect(controller.selected).toBeNull();
        expect(openedDirty).toBeNull();
        await act(async () => { flush.resolve(); });
        expect(controller.selected).toMatchObject({ key: marker.key });
        expect(openedDirty).toBe(true);

        await act(async () => { controller.close(); });
        flush = createDeferred<void>();
        await act(async () => { press?.('change', marker); });
        active = false;
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Markers /></KeyboardShortcutProvider>);
        await act(async () => { flush.resolve(); });
        expect(controller.selected).toBeNull();
    });
});
