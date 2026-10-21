import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { FileEditorAgentPresence } = await import('./FileEditorAgentPresence');
const { EditorAgentCaret } = await import('@/components/ui/motion/EditorAgentCaret');

const LINE = 22;
const CHAR = 8;
const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');

/** Monaco is the platform boundary: its geometry reads answer in window space and move with the scroll. */
function editorBoundary() {
    let scrollTop = 0;
    const listeners = new Set<() => void>();
    const handle: TextEditorHandle = {
        getValue: () => text,
        flushPendingChange: async () => {},
        getLineRect: (line) => ({ x: 100, y: 200 + (line - 1) * LINE - scrollTop, width: 600, height: LINE }),
        getPositionRect: (line, character) => ({ x: 100 + character * CHAR, y: 200 + (line - 1) * LINE - scrollTop, width: 1, height: LINE }),
        subscribeSelection: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    return { handle, scroll: (to: number) => { scrollTop = to; for (const listener of listeners) listener(); } };
}

describe('FileEditorAgentPresence (Edit mode)', () => {
    it('washes the written lines and stands the caret after the last one, following the editor scroll', async () => {
        const { handle, scroll } = editorBoundary();
        const presence = { startLine: 14, endLine: 15, agentId: null, agentName: 'Claude', reducedMotion: false };
        const screen = await renderScreen(<FileEditorAgentPresence handle={handle} presence={presence} />, {
            createNodeMock: () => ({ measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(80, 150, 800, 600) }),
        });
        try {
            await act(async () => {});
            const wash = screen.findByTestId('file-editor-agent-wash');
            expect(wash?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ left: 20, top: 200 + 13 * LINE - 150, height: 2 * LINE })]));
            const anchor = screen.findByTestId('file-editor-agent-caret');
            // After "line 15" (7 characters) on line 15.
            expect(anchor?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ left: 100 + 7 * CHAR - 80, top: 200 + 14 * LINE - 150 })]));
            expect(screen.findAllByType(EditorAgentCaret)).toHaveLength(1);

            await act(async () => { scroll(44); });
            expect(screen.findByTestId('file-editor-agent-caret')?.props.style)
                .toEqual(expect.arrayContaining([expect.objectContaining({ top: 200 + 14 * LINE - 150 - 44 })]));

            await screen.update(<FileEditorAgentPresence handle={handle} presence={null} />);
            expect(screen.findByTestId('file-editor-agent-caret')).toBeNull();
        } finally { await screen.unmount(); standardCleanup(); }
    });
});
