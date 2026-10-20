import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default } });
});

const { readCodeLineFromDomNode, resolveSourceLinesForText } = await import('./useDomTextSelection');

describe('read-body selection lines', () => {
    it('reads a text node\'s file line from its rendered code row', () => {
        const row = { id: ':r5:-f:23', parentElement: null, nodeType: 1 };
        const span = { id: '', parentElement: row, nodeType: 1 };
        const text = { parentElement: span, nodeType: 3 };
        expect(readCodeLineFromDomNode(text)).toBe(23);
        expect(readCodeLineFromDomNode({ parentElement: { id: 'pane', parentElement: null, nodeType: 1 }, nodeType: 3 })).toBeNull();
    });

    it('finds a rendered Markdown selection\'s lines in its source', () => {
        const source = '# Demo project\n\nA small project for Files & Editor QA.\n\nSee [the retry helper](src/retry.ts).\n';
        expect(resolveSourceLinesForText(source, 'A small project for Files & Editor QA.')).toEqual({ startLine: 3, endLine: 3 });
        expect(resolveSourceLinesForText(source, 'Demo project\nA small project')).toEqual({ startLine: 1, endLine: 3 });
        expect(resolveSourceLinesForText(source, 'nowhere')).toBeNull();
    });
});
