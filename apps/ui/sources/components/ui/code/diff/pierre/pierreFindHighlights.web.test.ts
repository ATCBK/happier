// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { registerPierreFindHighlights } from './pierreFindHighlights.web';

afterEach(() => vi.unstubAllGlobals());

describe('Pierre Find ranges', () => {
    it('marks UTF-16 ranges across syntax spans on the correct split side and preserves other diffs', () => {
        // The browser Highlight registry is the only substituted platform boundary.
        const highlights = new Map<string, Set<Range>>();
        vi.stubGlobal('CSS', { highlights });
        vi.stubGlobal('Highlight', class extends Set<Range> {
            constructor(...ranges: Range[]) { super(ranges); }
        });
        const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n+extra\n abc😀def\n tail\n';
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true });
        const line = lines.find(item => item.renderCodeText === 'abc😀def')!;
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<code data-deletions><div data-line-type="context" data-line="2">wrong side</div></code><code data-additions><div data-line-type="context" data-line="2"><span>abc😀</span><span>def</span></div></code>';
        const ranges = new Map([[line.id, [{ start: 3, end: 7, current: true }]]]);
        const stopFirst = registerPierreFindHighlights(root, lines, ranges);
        const stopSecond = registerPierreFindHighlights(root, lines, ranges);
        expect([...highlights.get('happier-find-current') ?? []].map(range => range.toString())).toEqual(['😀de', '😀de']);
        stopFirst();
        expect(highlights.get('happier-find-current')?.size).toBe(1);
        stopSecond();
        expect(highlights.size).toBe(0);
    });
});
