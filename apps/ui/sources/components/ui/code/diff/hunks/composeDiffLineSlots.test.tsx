import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { composeDiffLineSlots } from './composeDiffLineSlots';

describe('diff after-line content', () => {
    it('retains caller, fold, row and note in order, and leaves empty lines unannotated', async () => {
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: '@@ -1 +1 @@\n-before\n+after\n' });
        const slot = composeDiffLineSlots(
            (line) => line.kind === 'remove' ? <>comment</> : null,
            (line) => line.kind === 'remove' ? <>fold</> : null,
            (line) => line.kind === 'remove' ? <>row</> : null,
            (line) => line.kind === 'remove' ? <>note</> : null,
        );
        const changed = lines.find((line) => line.kind === 'remove')!;
        const screen = await renderScreen(<>{slot(changed)}</>);
        expect(screen.getTextContent().split(/\s+/)).toEqual(['comment', 'fold', 'row', 'note']);
        expect(slot(lines.find((line) => line.kind === 'add')!)).toBeNull();
    });
});
